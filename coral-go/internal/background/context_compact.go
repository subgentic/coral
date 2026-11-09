package background

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// Compacting a large context (#14849): an agent that is idle at its prompt with a context past the team's threshold gets the CLI's own compaction command, typed once. Most of what a
// busy team spends is the cache reads of requests whose context is over 200k tokens (94% of them in the Operator's own transcripts), and a compaction at a quiet moment cuts every later
// request. It is a team setting (HealthSettings.CompactContext), off by default, and acts only on a command the CLI is known to have: Claude's /compact, with a fixed focus line.
//
// It never interrupts a turn, never answers a dialog, never types over a draft (the automated-input gate), never compacts an agent with unread board messages (they are about to start
// a turn) or one a usage limit stops, and it types the same line every time: nothing from a task, a message or a transcript is in it.

const (
	// compactSettle is how long an agent must have been idle before it is compacted: a turn that has just ended may be followed at once by a board message or the person's next prompt.
	compactSettle = 20 * time.Second
	// compactCooldown is the least time between two compactions of one session: its next turn's context is what says whether another is due, and one compaction is never repeated on a stale reading.
	compactCooldown = 30 * time.Minute
	// compactFocusClaude is what Claude's /compact keeps.
	compactFocusClaude = "keep: open tasks, team rules, recent decisions, and what I was last asked"
)

// compactCommand is the command that compacts an agent of this type, "" for a type with none known to Coral (never guessed: Codex, Antigravity, Hermes and Pi have commands of their own, measured
// but not wired in this slice).
func compactCommand(agentType string) string {
	switch agentType {
	case "claude":
		return "/compact " + compactFocusClaude
	}
	return ""
}

// ContextCompact is the service.
type ContextCompact struct {
	store    *board.Store
	discover func(ctx context.Context) ([]AgentInfo, error)
	signal   func(ctx context.Context, sessionID string) (agentSignal, bool)
	// limit says whether a live agent is stopped by a usage limit; nil: nothing is.
	limit func(ctx context.Context, a AgentInfo) (time.Duration, bool)
	// tokens is the context size of each session's latest turn (store.TokenUsageStore.GetLatestTurnContextBySessionIDs).
	tokens func(ctx context.Context, sessionIDs []string) (map[string]int, error)
	// unread is each session's unread board messages (board.Store.UnreadForSessions).
	unread func(ctx context.Context, sessionNames []string) (map[string]board.SessionUnread, error)
	// finished is when a member last finished a task (board.Store.FinishedTaskAt); active says whether it has one in progress (HasActiveTaskForAssignee).
	finished func(ctx context.Context, project, subscriberID string) (time.Time, bool)
	active   func(ctx context.Context, project, subscriberID string) bool
	started  time.Time // a task finished before the service started is not a trigger: a restart compacts no one for old work
	// paused says whether a board is paused: nothing is typed on it; nil: none is.
	paused func(project string) bool
	// deliver types the command; false when the gate skipped it (a dialog, a draft, a held notice): it is asked again on the next pass.
	deliver func(ctx context.Context, a AgentInfo, text string) (bool, error)
	now     func() time.Time
	logger  *slog.Logger

	Interval time.Duration

	mu   sync.Mutex
	last map[string]compacted // by session name
}

type compacted struct {
	at     time.Time
	tokens int
}

// NewContextCompact returns the service with its design values.
func NewContextCompact(bs *board.Store, discover func(context.Context) ([]AgentInfo, error)) *ContextCompact {
	return &ContextCompact{store: bs, discover: discover, now: time.Now, started: time.Now(), logger: slog.Default().With("service", "context_compact"), Interval: time.Minute, last: map[string]compacted{}}
}

// Wire gives the service its views of the agents and the way to type through.
func (c *ContextCompact) Wire(signal func(context.Context, string) (agentSignal, bool), limit func(context.Context, AgentInfo) (time.Duration, bool),
	tokens func(context.Context, []string) (map[string]int, error), unread func(context.Context, []string) (map[string]board.SessionUnread, error),
	paused func(string) bool, rt AgentRuntime) {
	c.signal, c.limit, c.tokens, c.unread, c.paused = signal, limit, tokens, unread, paused
	c.deliver = func(ctx context.Context, a AgentInfo, text string) (bool, error) {
		return deliverCommand(ctx, rt, c.logger, naming.SessionName(a.AgentType, a.SessionID), a.AgentType, a.SessionID, text)
	}
}

// Attach wires the service to the stores and the runtime the other health services use.
func (c *ContextCompact) Attach(ts *store.TaskStore, usage *store.TokenUsageStore, rt AgentRuntime, paused func(string) bool) {
	c.Wire(hookSignal(ts), screenLimit(rt), usage.GetLatestTurnContextBySessionIDs, c.store.UnreadForSessions, paused, rt)
	c.finished = c.store.FinishedTaskAt
	c.active = func(ctx context.Context, project, id string) bool {
		busy, err := c.store.HasActiveTaskForAssignee(ctx, project, id, 0)
		return err != nil || busy // not told: treat it as at work
	}
}

// LastCompacted is when a session was last compacted by this service and the context it had then; false when it was not.
func (c *ContextCompact) LastCompacted(sessionName string) (time.Time, int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.last[sessionName]
	return r.at, r.tokens, ok
}

// Run scans until ctx ends.
func (c *ContextCompact) Run(ctx context.Context) error {
	return runOnTicker(ctx, c.Interval, func() { c.RunOnce(ctx) })
}

// RunOnce is one pass over every team that has the setting on.
func (c *ContextCompact) RunOnce(ctx context.Context) {
	if c.deliver == nil || c.signal == nil || c.tokens == nil || c.unread == nil {
		return
	}
	projects, err := c.store.ListProjects(ctx)
	if err != nil {
		return
	}
	var agents map[string]AgentInfo
	for _, p := range projects {
		hs := c.store.GetHealthSettings(ctx, p.Project).CompactContext
		if !hs.On {
			continue
		}
		if c.paused != nil && c.paused(p.Project) {
			continue
		}
		if agents == nil {
			live, err := c.discover(ctx)
			if err != nil {
				return
			}
			agents = map[string]AgentInfo{}
			for _, a := range live {
				agents[naming.SessionName(a.AgentType, a.SessionID)] = a
			}
		}
		c.runProject(ctx, p.Project, hs, agents)
	}
}

func (c *ContextCompact) runProject(ctx context.Context, project string, hs board.HealthCompact, agents map[string]AgentInfo) {
	subs, err := c.store.ListSubscribers(ctx, project)
	if err != nil {
		return
	}
	orch, _ := c.store.TeamOrchestrator(ctx, project)
	now := c.now()
	var cands []AgentInfo
	var names, ids, subIDs []string
	for _, sub := range subs {
		a, live := agents[sub.SessionName]
		if !live || sub.SessionName == "" || compactCommand(a.AgentType) == "" {
			continue
		}
		if !hs.Orchestrator && orch != "" && board.SameIdentity(sub.SubscriberID, orch) {
			continue
		}
		sig, ok := c.signal(ctx, a.SessionID)
		if !ok || sig.InTurn || sig.NeedsInput || now.Sub(sig.Since) < compactSettle {
			continue
		}
		c.mu.Lock()
		prev, did := c.last[sub.SessionName]
		c.mu.Unlock()
		if did && now.Sub(prev.at) < compactCooldown {
			continue
		}
		if c.limit != nil {
			if _, blocked := c.limit(ctx, a); blocked {
				continue
			}
		}
		cands = append(cands, a)
		names = append(names, sub.SessionName)
		ids = append(ids, a.SessionID)
		subIDs = append(subIDs, sub.SubscriberID)
	}
	if len(cands) == 0 {
		return
	}
	tok, err := c.tokens(ctx, ids)
	if err != nil {
		return
	}
	unread, err := c.unread(ctx, names)
	if err != nil {
		return
	}
	for i, a := range cands {
		n := tok[a.SessionID]
		trigger := hs.Trigger
		if trigger == "" {
			trigger = board.CompactTriggerThreshold
		}
		due := (trigger != board.CompactTriggerTask && n >= hs.ThresholdK*1000) ||
			(trigger != board.CompactTriggerThreshold && n >= board.CompactTaskFloorK*1000 && c.finishedAndFree(ctx, project, subIDs[i], names[i]))
		if !due {
			continue
		}
		if u, ok := unread[names[i]]; !ok || u.Err != nil || u.Unread > 0 {
			continue // messages waiting (or a count that failed): a turn is about to start
		}
		sent, err := c.deliver(ctx, a, compactCommand(a.AgentType))
		if err != nil {
			c.logger.Warn("compact not sent", "project", project, "session", names[i], "error", err)
			continue
		}
		if !sent {
			continue // a dialog, a draft or a held notice: asked again next pass
		}
		c.mu.Lock()
		c.last[names[i]] = compacted{at: now, tokens: n}
		c.mu.Unlock()
		c.logger.Info("compacted an idle agent's context", "project", project, "agent", a.DisplayName, "session", names[i], "context_tokens", n, "threshold_tokens", hs.ThresholdK*1000)
	}
}

// finishedAndFree is whether the member finished a task since the service started and since it was last compacted, and has none in progress: its work is done and it is waiting, so what it carries is only weight.
func (c *ContextCompact) finishedAndFree(ctx context.Context, project, subscriberID, sessionName string) bool {
	if c.finished == nil || c.active == nil {
		return false
	}
	at, ok := c.finished(ctx, project, subscriberID)
	if !ok || !at.After(c.started) {
		return false
	}
	c.mu.Lock()
	prev, did := c.last[sessionName]
	c.mu.Unlock()
	if did && !at.After(prev.at) {
		return false // this finish was answered already
	}
	return !c.active(ctx, project, subscriberID)
}

// deliverCommand types a slash command into an agent through the automated-input gate: as keystrokes, not a paste (a CLI runs a command it is typed, and may take a pasted one as text).
func deliverCommand(ctx context.Context, rt AgentRuntime, logger *slog.Logger, name, agentType, sessionID, text string) (bool, error) {
	if skipIfAgentExited(ctx, rt, logger, name, "compact") {
		return false, nil
	}
	delivery, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{
		Term: rt, Name: name, AgentType: agentType, SessionID: sessionID, Text: text, What: "context compact",
		Ready: func(ctx context.Context) error {
			if skipIfAgentExited(ctx, rt, logger, name, "compact") {
				return errSkippedExited
			}
			return nil
		},
		Send: func(ctx context.Context) error {
			if skipIfAgentExited(ctx, rt, logger, name, "compact") {
				return nil
			}
			return rt.SendInput(ctx, terminalinput.Coral, name, text)
		},
	})
	if err == errSkippedExited {
		return false, nil
	}
	return delivery != ptymanager.Skipped, err
}
