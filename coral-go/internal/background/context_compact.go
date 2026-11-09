package background

import (
	"context"
	"fmt"
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

const (
	// clearSettle is how long after a /clear the agent is left before its line is typed: the CLI starts the new session and shows its box.
	clearSettle = 10 * time.Second
	// clearGiveUp is how long a cleared agent is waited for: past it the line is dropped (the agent's own board nudges reach it anyway).
	clearGiveUp = 5 * time.Minute
)

const (
	// handoffWait is how long an agent is given to write its handoff note: past it the clear is dropped (nothing is lost, the agent was not cleared) and it is left alone for the cooldown.
	handoffWait = 10 * time.Minute
	// handoffName is the name of the note's artifact.
	handoffName = "handoff.md"
)

// askHandoffText is the one fixed line that asks an agent for its handoff note before it is cleared.
func askHandoffText() string {
	return "[Coral] Your context will be cleared to save tokens. First write what you need to continue (the work in hand, what you decided, what is next) into one file and upload it: run 'coral-agent artifact upload FILE --name " + handoffName + " --tag internal' with the name of that file in place of FILE. Then stop and wait."
}

// handoffText is the line a cleared agent is sent when it has a handoff note: the note's digest is Coral's own (64 hex of its store), the only variable.
func handoffText(digest string) string {
	return fmt.Sprintf("[Coral] Your context was cleared to save tokens. Your handoff note is coral://artifacts/%s: run 'coral-agent artifact download coral://artifacts/%s' to read it, then 'coral-board read' for your board, and continue.", digest, digest)
}

// clearCommand is the command that clears an agent's context, "" for a type with none known to Coral.
func clearCommand(agentType string) string {
	if agentType == "claude" {
		return "/clear"
	}
	return ""
}

// clearedText is the one fixed line a cleared agent is sent: a notice (it starts with a notice opener), with the number of its next task and nothing else that is not Coral's own words.
func clearedText(next int64) string {
	if next > 0 {
		return fmt.Sprintf("[Coral] Your context was cleared to save tokens. Read your board with 'coral-board read', then run 'coral-board task claim %d' to start your next task.", next)
	}
	return "[Coral] Your context was cleared to save tokens. Read your board with 'coral-board read', then run 'coral-board wait' for your next task."
}

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

	// handoff is the digest of the newest upload this session made after since that is named handoff.md, "" when there is none (server.LatestUpload); nil: the handoff method is unavailable.
	handoff func(sessionID string, since time.Time) string
	// nextTask is the number of the next task assigned to a member (board.Store.NextPendingTaskForSubscriber), 0 when there is none.
	nextTask func(ctx context.Context, project, subscriberID string) int64

	mu      sync.Mutex
	last    map[string]compacted  // by session name
	pending map[string]bootstrap  // a cleared agent waits here for its one line, by session name
	asked   map[string]handoffAsk // an agent that was asked for its handoff note waits here, by session name
}

// handoffAsk is an agent that was asked to write its handoff note: when, and what it needs to be cleared by.
type handoffAsk struct {
	at time.Time
}

// bootstrap is the line a cleared agent is sent once it has settled.
type bootstrap struct {
	at   time.Time
	text string
}

type compacted struct {
	at     time.Time
	tokens int
}

// NewContextCompact returns the service with its design values.
func NewContextCompact(bs *board.Store, discover func(context.Context) ([]AgentInfo, error)) *ContextCompact {
	return &ContextCompact{store: bs, discover: discover, now: time.Now, started: time.Now(), logger: slog.Default().With("service", "context_compact"), Interval: time.Minute, last: map[string]compacted{}, pending: map[string]bootstrap{}, asked: map[string]handoffAsk{}}
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
func (c *ContextCompact) Attach(ts *store.TaskStore, usage *store.TokenUsageStore, rt AgentRuntime, paused func(string) bool, handoff func(sessionID, name string, since time.Time) string) {
	if handoff != nil {
		c.handoff = func(sessionID string, since time.Time) string { return handoff(sessionID, handoffName, since) }
	}
	c.Wire(hookSignal(ts), screenLimit(rt), usage.GetLatestTurnContextBySessionIDs, c.store.UnreadForSessions, paused, rt)
	c.finished = c.store.FinishedTaskAt
	c.nextTask = func(ctx context.Context, project, id string) int64 {
		if t := c.store.NextPendingTaskForSubscriber(ctx, project, id); t != nil && t.AssignedTo != nil && board.SameIdentity(*t.AssignedTo, id) {
			return t.ID
		}
		return 0
	}
	c.active = c.busy
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
	c.sendPending(ctx)
	c.clearAsked(ctx)
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
		command, next := compactCommand(a.AgentType), int64(0)
		if hs.Method == board.CompactMethodClearHandoff && clearCommand(a.AgentType) != "" && c.handoff != nil {
			// The agent is asked for its note first; it is cleared by clearAsked once the note is stored. Only an agent with no task in progress, and only once.
			if c.active == nil || c.active(ctx, project, subIDs[i]) {
				continue
			}
			c.mu.Lock()
			_, waiting := c.asked[names[i]]
			c.mu.Unlock()
			if waiting {
				continue
			}
			if sent, err := c.deliver(ctx, a, askHandoffText()); err == nil && sent {
				c.mu.Lock()
				c.asked[names[i]] = handoffAsk{at: now}
				c.mu.Unlock()
				c.logger.Info("asked an idle agent for its handoff note", "project", project, "agent", a.DisplayName, "session", names[i], "context_tokens", n)
			}
			continue
		}
		if hs.Method == board.CompactMethodClearNext && clearCommand(a.AgentType) != "" {
			// A clear forgets the work in hand: only an agent with no task in progress is cleared, whatever the trigger.
			if c.active == nil || c.active(ctx, project, subIDs[i]) {
				continue
			}
			command = clearCommand(a.AgentType)
			if c.nextTask != nil {
				next = c.nextTask(ctx, project, subIDs[i])
			}
		}
		sent, err := c.deliver(ctx, a, command)
		if err != nil {
			c.logger.Warn("compact not sent", "project", project, "session", names[i], "error", err)
			continue
		}
		if !sent {
			continue // a dialog, a draft or a held notice: asked again next pass
		}
		c.mu.Lock()
		c.last[names[i]] = compacted{at: now, tokens: n}
		if command == clearCommand(a.AgentType) && command != "" {
			c.pending[names[i]] = bootstrap{at: now, text: clearedText(next)}
		}
		c.mu.Unlock()
		c.logger.Info("compacted or cleared an idle agent's context", "project", project, "agent", a.DisplayName, "session", names[i], "command", command, "context_tokens", n, "threshold_tokens", hs.ThresholdK*1000)
	}
}

// busy is whether the member has a task in progress; a read that fails is "busy", never "free": an agent is compacted or cleared only when the board says it has nothing in hand (#14849, QA's T8).
func (c *ContextCompact) busy(ctx context.Context, project, subscriberID string) bool {
	busy, err := c.store.HasActiveTaskForAssignee(ctx, project, subscriberID, 0)
	return err != nil || busy
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

// sendPending types the one line to each cleared agent that has settled: idle at its box, ten seconds after the clear. A line is typed once; an agent that is gone, or is not settled within five minutes, is dropped.
func (c *ContextCompact) sendPending(ctx context.Context) {
	c.mu.Lock()
	if len(c.pending) == 0 {
		c.mu.Unlock()
		return
	}
	todo := map[string]bootstrap{}
	for name, p := range c.pending {
		todo[name] = p
	}
	c.mu.Unlock()
	live, err := c.discover(ctx)
	if err != nil {
		return
	}
	agents := map[string]AgentInfo{}
	for _, a := range live {
		agents[naming.SessionName(a.AgentType, a.SessionID)] = a
	}
	now := c.now()
	for name, p := range todo {
		a, ok := agents[name]
		if !ok || now.Sub(p.at) > clearGiveUp {
			c.drop(name)
			continue
		}
		sig, known := c.signal(ctx, a.SessionID)
		if !known || sig.InTurn || sig.NeedsInput || now.Sub(p.at) < clearSettle {
			continue
		}
		if sent, err := c.deliver(ctx, a, p.text); err == nil && sent {
			c.drop(name)
		}
	}
}

func (c *ContextCompact) drop(name string) {
	c.mu.Lock()
	delete(c.pending, name)
	c.mu.Unlock()
}

// clearAsked clears each agent that was asked for its handoff note and has stored it: idle again (the note is written in a turn of its own), the note's artifact there; then it is sent the line that
// names the note. An agent that has not written one within handoffWait is left as it is (not cleared) and not asked again for the cooldown; a gone agent is forgotten.
func (c *ContextCompact) clearAsked(ctx context.Context) {
	c.mu.Lock()
	if len(c.asked) == 0 {
		c.mu.Unlock()
		return
	}
	todo := map[string]handoffAsk{}
	for name, a := range c.asked {
		todo[name] = a
	}
	c.mu.Unlock()
	if c.handoff == nil {
		return
	}
	live, err := c.discover(ctx)
	if err != nil {
		return
	}
	agents := map[string]AgentInfo{}
	for _, a := range live {
		agents[naming.SessionName(a.AgentType, a.SessionID)] = a
	}
	now := c.now()
	for name, ask := range todo {
		a, ok := agents[name]
		if !ok {
			c.forgetAsk(name, false, now)
			continue
		}
		if now.Sub(ask.at) > handoffWait {
			c.logger.Info("an agent did not write its handoff note: not cleared", "session", name)
			c.forgetAsk(name, true, now)
			continue
		}
		sig, known := c.signal(ctx, a.SessionID)
		if !known || sig.InTurn || sig.NeedsInput || now.Sub(sig.Since) < compactSettle {
			continue
		}
		digest := c.handoff(a.SessionID, ask.at)
		if digest == "" {
			continue
		}
		if sent, err := c.deliver(ctx, a, clearCommand(a.AgentType)); err == nil && sent {
			c.mu.Lock()
			delete(c.asked, name)
			c.last[name] = compacted{at: now}
			c.pending[name] = bootstrap{at: now, text: handoffText(digest)}
			c.mu.Unlock()
			c.logger.Info("cleared an agent after its handoff note", "session", name, "note", digest[:12])
		}
	}
}

// forgetAsk ends a wait for a note; cooldown keeps the agent from being asked again at once.
func (c *ContextCompact) forgetAsk(name string, cooldown bool, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.asked, name)
	if cooldown {
		c.last[name] = compacted{at: now}
	}
}
