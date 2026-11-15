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
// its turn ended; the live row serves it as stalled_task {team, task_id, title, since}, the dashboard turns it into a Needs you row ("Stopped with task #3 in progress": Restart, Reassign) and the team header
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
}

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
		read[p.Project] = true
		if !busy || (h.boardHandler != nil && h.boardHandler.IsPaused(p.Project)) {
			continue // nothing in progress, or the person paused the team: nobody is expected to be taking turns
		}
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
		for _, a := range agents {
			if st := stalledOf(a, p.Project, now, after); st != nil {
				found[st.SessionID] = st
			}
		}
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
	// Everything quoted went through noticeText (no mention can fire from a title or a name) and is posted by postNotice, the one place that posts defused text (the notice census).
	line := fmt.Sprintf("@%s [Coral] %s is stopped with task #%d in progress (%s): no turn for 2 minutes. It is not working, so do not wait on it. The Operator has been asked to restart it; you can reassign the task.",
		orch, h.boardHandler.noticeText(ctx, st.Team, st.Agent), st.TaskID, quoteNotice(h.boardHandler.noticeText(ctx, st.Team, st.Title)))
	h.boardHandler.postNotice(ctx, st.Team, line, "Coral")
	h.stalls.mu.Lock()
	if e := h.stalls.seen[st.SessionID]; e != nil {
		e.toldOrch = true
	}
	h.stalls.mu.Unlock()
}
