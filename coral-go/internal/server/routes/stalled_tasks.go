package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// A stopped agent that holds an in-progress task (#16921, walk 42 H1). The person pressed Stop on an agent that had claimed task #3: it sat idle, the task stayed In progress, Needs you said 0, the team header
// said All well and the Orchestrator wrote "QA is the one working, I'll wait". An agent that crashed, hit a limit or lost its laptop would have been waited on for ever the same way.
//
// An agent whose board status is task_idle (it holds a task in progress, has no turn going on, waits on nothing and asks for nothing) for stalledTaskAfter is STALLED. The pass keeps, per agent, the task and when
// its turn ended; the live row serves it as stalled_task {team, task_id, title, since}, the dashboard turns it into a Needs you row ("Idle with task #3 in progress": Restart, Reassign) and the team header
// counts it; the server's own needs-you read lists it too. The team's Orchestrator is told once, on the board, so it stops waiting. The row clears when the agent takes a turn or the task moves.

// stalledTaskAfter is how long an agent holds an in-progress task with no turn before it is stalled.
const stalledTaskAfter = 2 * time.Minute

// stalledTask is one stalled agent's record.
type stalledTask struct {
	Team      string
	Agent     string // its name on the board
	TaskID    int64
	Title     string // cleaned and cut: an agent wrote it
	Since     time.Time
	SessionID string
	AgentType string
	toldOrch  bool
	taskKey   string
}

// stalledWatch is the table of stalled agents by session id; its zero value is ready.
type stalledWatch struct {
	mu   sync.Mutex
	seen map[string]*stalledTask
	// quietUntil: a board read with no task_idle agent on it is not read again until then (#17005): an agent needs stalledTaskAfter of idleness to be stalled, so a quiet board loses nothing by being read every 45 s instead of every 15.
	quietUntil map[string]time.Time
}

// stalledQuietFor is how long a board with no task_idle agent is left alone.
const stalledQuietFor = 45 * time.Second

const stalledTitleMax = 80

func stalledTitle(s string) string {
	s = strings.Join(strings.Fields(clitext.Clean(s)), " ")
	if r := []rune(s); len(r) > stalledTitleMax {
		s = strings.TrimSpace(string(r[:stalledTitleMax-1])) + "…"
	}
	return s
}

// stalledOf is the record for a status row, or nil when the agent is not stalled at now: task_idle, a board task in progress, and idle since long enough. An agent with no known idle start is not counted (no guess).
func stalledOf(a availableAgent, team string, now time.Time, after time.Duration) *stalledTask {
	if a.Availability != "task_idle" || a.SessionID == "" || a.IdleSince == "" {
		return nil
	}
	since, err := time.Parse(time.RFC3339, a.IdleSince)
	if err != nil || now.Sub(since) < after {
		return nil
	}
	for _, t := range a.Tasks {
		if t.Scope != "personal" && t.Status == "in_progress" {
			return &stalledTask{Team: team, Agent: a.Name, TaskID: t.ID, Title: stalledTitle(t.Title), Since: since, SessionID: a.SessionID, AgentType: a.AgentType, taskKey: fmt.Sprintf("%d|%s", t.ID, a.IdleSince)}
		}
	}
	return nil
}

// replace sets the stalled agents of the boards that were read: an agent of such a board that is not in found is no longer stalled. It returns the ones that are new (or whose task changed) since the last pass.
func (w *stalledWatch) replace(found map[string]*stalledTask, read map[string]bool) (fresh []*stalledTask) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seen == nil {
		w.seen = map[string]*stalledTask{}
	}
	for sid, e := range w.seen {
		if read[e.Team] && found[sid] == nil {
			delete(w.seen, sid)
		}
	}
	for sid, f := range found {
		if e := w.seen[sid]; e != nil && e.taskKey == f.taskKey {
			continue
		}
		w.seen[sid] = f
		fresh = append(fresh, f)
	}
	return fresh
}

func (w *stalledWatch) isQuiet(project string, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return now.Before(w.quietUntil[project])
}

// pruneQuiet forgets the quiet time of a board that is no longer listed (a deleted team), so the table does not grow with the teams that came and went (#18013).
func (w *stalledWatch) pruneQuiet(listed map[string]bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for project := range w.quietUntil {
		if !listed[project] {
			delete(w.quietUntil, project)
		}
	}
}

func (w *stalledWatch) setQuiet(project string, quiet bool, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.quietUntil == nil {
		w.quietUntil = map[string]time.Time{}
	}
	if quiet {
		w.quietUntil[project] = now.Add(stalledQuietFor)
	} else {
		delete(w.quietUntil, project)
	}
}

// field is the live row's stalled_task: nil unless the agent is stalled.
func (w *stalledWatch) field(sid string) any {
	w.mu.Lock()
	defer w.mu.Unlock()
	e := w.seen[sid]
	if e == nil {
		return nil
	}
	return map[string]any{"team": e.Team, "task_id": e.TaskID, "title": e.Title, "since": e.Since.UTC().Format(time.RFC3339), "agent": e.Agent}
}

// all lists the stalled agents (a copy).
func (w *stalledWatch) all() []stalledTask {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]stalledTask, 0, len(w.seen))
	for _, e := range w.seen {
		out = append(out, *e)
	}
	return out
}

// stalledPass is one pass over every board that has a task in progress. now and after are the clock and the bound (tests set them).
func (h *SessionsHandler) stalledPass(ctx context.Context, now time.Time, after time.Duration) {
	if h.bs == nil || h.ss == nil {
		return
	}
	projects, err := h.bs.ListProjects(ctx)
	if err != nil {
		return
	}
	found := map[string]*stalledTask{}
	read := map[string]bool{}
	listed := make(map[string]bool, len(projects))
	for _, p := range projects {
		listed[p.Project] = true
	}
	h.stalls.pruneQuiet(listed)
	for _, p := range projects {
		if ctx.Err() != nil {
			return
		}
		tasks, err := h.bs.ListOpenTaskStates(ctx, p.Project)
		if err != nil {
			continue
		}
		busy := false
		for _, t := range tasks {
			busy = busy || t.Status == "in_progress"
		}
		if !busy || (h.boardHandler != nil && h.boardHandler.IsPaused(p.Project)) {
			read[p.Project] = true
			continue // nothing in progress, or the person paused the team: nobody is expected to be taking turns
		}
		if h.stalls.isQuiet(p.Project, now) {
			continue // read a moment ago with nobody idle on a task: what it held stays as it was (a stalled agent is never on a quiet board)
		}
		read[p.Project] = true
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
		if err != nil {
			continue
		}
		snap, serr := h.loadBoardStatus(req, newPhaseTrace("stalled-tasks"), p.Project, false, "")
		if serr != nil {
			delete(read, p.Project) // not read this time: what it held stays as it was
			continue
		}
		agents, _ := h.liveStatusAgents(ctx, snap, p.Project, false)
		candidate := false
		for _, a := range agents {
			candidate = candidate || a.Availability == "task_idle"
			if st := stalledOf(a, p.Project, now, after); st != nil {
				found[st.SessionID] = st
			}
		}
		h.stalls.setQuiet(p.Project, !candidate, now)
	}
	for _, st := range h.stalls.replace(found, read) {
		h.tellOrchestratorStalled(ctx, st)
	}
}

// tellOrchestratorStalled posts one line on the team's board to its Orchestrator so it does not wait on an agent that is not working. Nothing is posted when the stalled agent is the Orchestrator itself.
func (h *SessionsHandler) tellOrchestratorStalled(ctx context.Context, st *stalledTask) {
	orch, err := h.bs.TeamOrchestrator(ctx, st.Team)
	if err != nil || orch == "" || board.SameIdentity(orch, st.Agent) {
		return
	}
	if h.boardHandler == nil {
		return
	}
	// A restart forgets what was said: the board remembers. A notice for this task and agent since it went idle is not said again (#17005).
	if h.alreadyToldStalled(ctx, st) {
		return
	}
	// Everything quoted went through noticeText (no mention can fire from a title or a name) and is posted by postNotice, the one place that posts defused text (the notice census).
	line := fmt.Sprintf("@%s [Coral] %s is idle with task #%d in progress (%s): no turn for 2 minutes. It may have been stopped, or be waiting on something it did not register, so ask it before you wait on it. It is on the Operator's Needs you with Restart and Reassign; you can reassign the task.",
		orch, h.boardHandler.noticeText(ctx, st.Team, st.Agent), st.TaskID, quoteNotice(h.boardHandler.noticeText(ctx, st.Team, st.Title)))
	h.boardHandler.postNotice(ctx, st.Team, line, "Coral")
	h.stalls.mu.Lock()
	if e := h.stalls.seen[st.SessionID]; e != nil {
		e.toldOrch = true
	}
	h.stalls.mu.Unlock()
}

// alreadyToldStalled is whether the board's recent messages hold this notice (this task, this agent) written after the agent went idle.
func (h *SessionsHandler) alreadyToldStalled(ctx context.Context, st *stalledTask) bool {
	msgs, err := h.bs.ListMessages(ctx, st.Team, 100, 0, 0)
	if err != nil {
		return false
	}
	name := h.boardHandler.noticeText(ctx, st.Team, st.Agent)
	want := fmt.Sprintf("task #%d in progress", st.TaskID)
	for _, m := range msgs {
		if !m.IsSystem || !strings.Contains(m.Content, want) || !strings.Contains(m.Content, "[Coral] "+name+" is ") { // the name starts the notice's own words: "Engineer 3" is not "QA Engineer 3" (#18013)
			continue
		}
		if at, ok := boardMessageTime(m.CreatedAt); ok && !at.Before(st.Since) {
			return true
		}
	}
	return false
}

// boardMessageTime reads a message's created_at, RFC3339 or the store's "2006-01-02 15:04:05" (UTC).
func boardMessageTime(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
