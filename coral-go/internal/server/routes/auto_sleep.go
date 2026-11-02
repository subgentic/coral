package routes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/machinehealth"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// The auto-sleeper (#12111, goal #194): once a minute it looks at every awake agent and puts the ones idle past the Operator's minutes to sleep, with the reason idle. What it may not
// sleep is autoSleepVerdict's list; this file reads the world into that list's input and does the sleep.

const (
	autoSleepEvery    = time.Minute
	autoSleepMaxProcs = 512 // a process tree larger than this is not read: it counts as busy
	// An agent whose process tree used more than this much CPU in the last look is working on something (a background run, a build): it is not asleep material.
	autoSleepBusyCPU = 2.0 // CPU seconds between two looks a minute apart
)

// autoSleepSamples is each agent's process-tree CPU at the last look, so the next look can say whether anything ran in between.
var autoSleepSamples = struct {
	sync.Mutex
	m map[string]cpuSample
}{m: map[string]cpuSample{}}

type cpuSample struct {
	cpu float64
	at  time.Time
}

// RunAutoSleep blocks until ctx is done, putting idle agents to sleep once a minute.
func (h *SessionsHandler) RunAutoSleep(ctx context.Context) {
	t := time.NewTicker(autoSleepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			h.autoSleepPass(ctx, now)
		}
	}
}

// autoSleepPass is one look at every awake agent.
func (h *SessionsHandler) autoSleepPass(ctx context.Context, now time.Time) {
	settings, err := h.ss.GetSettings(ctx)
	if err != nil || !setreg.Bool(settings, setreg.AutoSleep) {
		return
	}
	idle := time.Duration(setreg.Int(settings, setreg.AutoSleepIdleMinutes)) * time.Minute
	rows, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for i := range rows {
		ls := &rows[i]
		if ls.IsSleeping != 0 || ls.IsArchived != 0 {
			continue
		}
		seen[ls.SessionID] = true
		in, rss := h.autoSleepInputOf(ctx, ls, settings, idle, now)
		if why := autoSleepVerdict(in); why != "" {
			slog.Debug("auto_sleep skipped", "session_id", ls.SessionID, "reason", why)
			continue
		}
		h.autoSleepOne(ctx, ls, idle, rss, now)
	}
	autoSleepSamples.Lock() // the samples of agents that are gone are dropped
	for sid := range autoSleepSamples.m {
		if !seen[sid] {
			delete(autoSleepSamples.m, sid)
		}
	}
	autoSleepSamples.Unlock()
}

// autoSleepInputOf reads what the verdict needs about one agent, as late and as cheaply as it can: the checks that cost a screen read or a process table read come last, and only for an
// agent that has been idle long enough for them to matter. rss is its process tree's resident bytes now (the memory a sleep frees).
func (h *SessionsHandler) autoSleepInputOf(ctx context.Context, ls *store.LiveSession, settings map[string]string, idle time.Duration, now time.Time) (in autoSleepInput, rss uint64) {
	in = autoSleepInput{Now: now, On: true, IdleFor: idle, Terminal: ls.AgentType == "terminal", Job: ls.IsJob != 0}
	if st, err := h.ss.AutoSleepStateOf(ctx, ls.SessionID); err == nil {
		in.OptedOut = st.Off
		if st.SleptAt > 0 {
			in.SleptAt = time.Unix(st.SleptAt, 0)
		}
		if st.WokenAt > 0 {
			in.WokenAt = time.Unix(st.WokenAt, 0)
		}
	} else {
		in.OptedOut = true // unreadable: not slept
	}
	in.Chief = setreg.Bool(settings, "chief_page") && strings.TrimSpace(setreg.Text(settings, "chief_session")) == ls.SessionID
	name := naming.SessionName(ls.AgentType, ls.SessionID)
	var sub *board.Subscriber
	if h.bs != nil && ptr.Value(ls.BoardName) != "" {
		sub, _ = h.bs.GetSubscriptionBySessionName(ctx, name)
		in.Orch = sub != nil && sub.CanPeek != 0
	}
	state := h.deriveSingleSessionState(ctx, ls.SessionID, 0)
	in.InTurn, in.NeedsInput = state.InTurn || state.Working, state.NeedsInput
	in.LastActive = state.LastEvent
	if state.LastStop.After(in.LastActive) {
		in.LastActive = state.LastStop
	}
	if in.LastActive.IsZero() { // an agent that never did anything is idle from its launch
		if t, err := time.Parse(time.RFC3339, ptr.Value(ls.LaunchedAt)); err == nil {
			in.LastActive = t
		}
	}
	if autoSleepVerdict(in) != "" { // the cheap reasons come first: nothing below is read for an agent that is already staying awake
		return in, 0
	}
	if h.bs != nil && sub != nil {
		project := ptr.Value(ls.BoardName)
		in.ActiveWait = h.activeWaitOf(ctx, project, sub.SubscriberID)
		in.ClaimedTask = h.claimedTaskOf(ctx, project, sub.SubscriberID)
		in.ReviewOwed = h.reviewOwedBy(ctx, project, sub.SubscriberID)
		in.OperatorAsk = h.operatorWaitsOn(ctx, project, sub.SubscriberID)
	}
	if skip, ok := ptymanager.SkippedOf(name); ok && strings.HasPrefix(skip.Why, ptymanager.SkipPrompt) {
		in.Dialog = true
	}
	if autoSleepVerdict(in) != "" {
		return in, 0
	}
	switch ptymanager.ScreenStopsSleep(ctx, h.terminal, name, ls.AgentType, ls.SessionID) {
	case "":
	case ptymanager.SleepStopDialog:
		in.Dialog = true
	case ptymanager.SleepStopBackground:
		in.Background = true
	default:
		in.Draft = true
	}
	if autoSleepVerdict(in) != "" {
		return in, 0
	}
	in.ProcBusy, in.ProcUnknown, rss = h.autoSleepProcess(ctx, ls, name, now)
	return in, rss
}

// autoSleepProcess says whether the agent's process tree used the CPU since the last look. The first look of an agent only takes a baseline and counts as busy; a tree that cannot be named,
// read or bounded is unknown, which keeps the agent awake.
func (h *SessionsHandler) autoSleepProcess(ctx context.Context, ls *store.LiveSession, name string, now time.Time) (busy, unknown bool, rss uint64) {
	pids, ok := h.terminal.(ptymanager.PanePIDer)
	if !ok {
		return false, true, 0
	}
	root, err := pids.PanePID(ctx, name, ls.AgentType, ls.SessionID)
	if err != nil || root <= 0 {
		return false, true, 0
	}
	cpu, rss, _, read := machinehealth.TreeUsage(ctx, root, autoSleepMaxProcs)
	if !read {
		return false, true, 0
	}
	autoSleepSamples.Lock()
	prev, had := autoSleepSamples.m[ls.SessionID]
	autoSleepSamples.m[ls.SessionID] = cpuSample{cpu: cpu, at: now}
	autoSleepSamples.Unlock()
	if !had || cpu < prev.cpu { // no baseline yet, or a process of the tree was replaced
		return true, false, rss
	}
	return cpu-prev.cpu > autoSleepBusyCPU, false, rss
}

func (h *SessionsHandler) activeWaitOf(ctx context.Context, project, member string) bool {
	w, err := h.bs.GetActiveWait(ctx, project, member)
	return err != nil || w != nil // unreadable: waiting
}

func (h *SessionsHandler) claimedTaskOf(ctx context.Context, project, member string) bool {
	tasks, err := h.bs.ListTasks(ctx, project)
	if err != nil {
		return true
	}
	for _, t := range tasks {
		if t.AssignedTo != nil && board.SameIdentity(*t.AssignedTo, member) && (t.Status == "in_progress" || t.Status == "review") {
			return true
		}
	}
	return false
}

// reviewOwedBy: the member is named on a task in review whose round of review has not ended.
func (h *SessionsHandler) reviewOwedBy(ctx context.Context, project, member string) bool {
	waits, err := h.bs.ReviewWaits(ctx, project)
	if err != nil {
		return true
	}
	for _, rw := range waits {
		for _, n := range rw.With {
			if strings.EqualFold(n, member) || board.SameIdentity(n, member) {
				return true
			}
		}
	}
	return false
}

// operatorWaitsOn: the member has a question open to the Operator, whichever way it asked (a wait or an ask), as the Orchestrator's sleep refuses.
func (h *SessionsHandler) operatorWaitsOn(ctx context.Context, project, member string) bool {
	qs, err := h.bs.ListOperatorQuestions(ctx, project)
	if err != nil {
		return true
	}
	for _, q := range qs {
		if strings.EqualFold(q.SubscriberID, member) {
			return true
		}
	}
	asks, err := h.bs.OpenAsks(ctx, project, time.Now())
	if err != nil {
		return true
	}
	for _, a := range asks {
		if strings.EqualFold(a.Member, "Operator") && strings.EqualFold(a.Asker, member) {
			return true
		}
	}
	return false
}

// autoSleepOne puts one agent to sleep: the row first (asleep, reason idle, the clock, in one write), then the terminal. A crash between the two leaves a sleeping row, which a wake
// starts again; the reverse would leave a live row with no terminal.
func (h *SessionsHandler) autoSleepOne(ctx context.Context, ls *store.LiveSession, idle time.Duration, rss uint64, now time.Time) {
	if err := h.ss.SetSessionAutoSleeping(ctx, ls.SessionID, now); err != nil {
		if !errors.Is(err, sql.ErrNoRows) { // not awake any more: a person's Sleep came first, and that is not an error
			slog.Warn("auto_sleep failed", "session_id", ls.SessionID, "error", err)
		}
		return
	}
	h.modelSwitches.end(ls.SessionID, "The agent was put to sleep before the change was confirmed.")
	h.stopOpencode(ls.SessionID)
	if err := h.terminal.KillSessionOnly(ctx, ls.AgentName, ls.AgentType, ls.SessionID); err != nil {
		slog.Warn("auto_sleep: the terminal was not killed", "session_id", ls.SessionID, "error", err)
	}
	h.noteFirstAutoSleep(ctx, ls, idle)
	slog.Info("auto_sleep", "session_id", ls.SessionID, "agent_type", ls.AgentType, "idle_minutes", int(idle/time.Minute), "memory_freed_bytes", rss)
	h.kickWS()
}

// autoSleepNoticeSeen is the setting that remembers the one-time line was shown (Security, #12111: the default is on for every agent, so the first time one is put to sleep the Operator is told
// once, on that agent's board, what happened and where the switches are). It is written by Coral only.
const autoSleepNoticeSeen = "auto_sleep_notice_seen"

// noteFirstAutoSleep posts the one-time line on the agent's board the first time Coral auto-sleeps any agent.
func (h *SessionsHandler) noteFirstAutoSleep(ctx context.Context, ls *store.LiveSession, idle time.Duration) {
	settings, err := h.ss.GetSettings(ctx)
	if err != nil || settings[autoSleepNoticeSeen] == "true" {
		return
	}
	if err := h.ss.SetSetting(ctx, autoSleepNoticeSeen, "true"); err != nil {
		return // not marked: it would say it again every time
	}
	project := ptr.Value(ls.BoardName)
	if h.bs == nil || project == "" {
		return
	}
	name := h.noticeName(ctx, *ls)
	if name == "" {
		name = "An agent"
	}
	text := fmt.Sprintf("Coral put %s to sleep after %d minutes without activity. Any message, task or review for it wakes it with its conversation. Turn this off for one agent on its page, or for all agents in Settings (auto_sleep).", name, int(idle/time.Minute))
	if _, err := h.bs.PostSystemMessage(ctx, project, board.CoralSender, text, nil); err != nil {
		slog.Warn("auto_sleep: the first-time line was not posted", "error", err)
	}
}
