package background

import (
	"context"
	"log/slog"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/limitwaits"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
)

// LimitCounter records the limit waits (feature bets stage 1, task 2, #21020): each time an agent is stopped by its vendor's usage limit, one wait, and how it ended: at the reset time (or after it), earlier
// than the reset (a person resumed it, a new login), or neither (the agent went away, or the CLI named no reset time). The cost page counts them per agent and day. It watches whether or not Coral resumes agents
// at the reset (LimitResumer, behind a setting): the count is of what happened, not of what Coral did.
//   - It reads a limit the way the live row does (the Claude transcript's rate-limit error; for Codex and agy the health monitor's screen read), so the count agrees with what a person sees.
//   - One wait per limit: the same reset read again (a screen's "in 3 h" drifts by seconds, resetTolerance) is the same wait. A read that stops saying limited has to stay gone for two looks before the wait
//     ends (a screen read that fails once does not end a wait and start another), and the wait ends when it was first missed.
//   - A limit whose reset is older than limitResumeLate at the first look is an old error left in a transcript, not a wait.
//   - Open waits are in the record: after a restart the counter goes on with them (an agent that still waits is not counted a second time).
//   - A counter that fails to write loses a count and nothing else.
type LimitCounter struct {
	interval time.Duration
	logger   *slog.Logger
	now      func() time.Time

	discover func(ctx context.Context) ([]AgentInfo, error)
	// state says whether a is stopped by a usage limit and when it resets (zero: the CLI printed no time).
	state func(ctx context.Context, a AgentInfo, now time.Time) (time.Time, bool)
	// teamOf is every agent's team by session name ("<cli>-<session id>"), read once a look; nil: no teams are recorded.
	teamOf func(ctx context.Context) map[string]string
	store  limitWaitSink

	mu     sync.Mutex
	loaded bool
	open   map[string]*openWait // by session id
}

// limitWaitSink is the record the counter writes (limitwaits.Store).
type limitWaitSink interface {
	Begin(w limitwaits.Wait) (int64, error)
	End(id int64, at time.Time, kind string) error
	Open() ([]limitwaits.Wait, error)
}

type openWait struct {
	id      int64
	resetAt time.Time
	// missed counts the looks since the limit (or the agent) was last seen; missedAt is the first of them.
	missed   int
	missedAt time.Time
	gone     bool // the misses are the agent's absence, not a read that no longer says limited
}

// limitMarkMaxAge is how old a screen's limit mark may be and still count (as the live row's usageLimitMaxAge).
const limitMarkMaxAge = 10 * time.Minute

// limitCounterMisses is how many looks in a row must miss the limit (or the agent) before the wait ends.
const limitCounterMisses = 2

// NewLimitCounter is a counter that looks every interval (a minute when 0), writing to store.
func NewLimitCounter(interval time.Duration, store limitWaitSink) *LimitCounter {
	if interval <= 0 {
		interval = time.Minute
	}
	return &LimitCounter{interval: interval, logger: slog.Default().With("service", "limit_counter"), now: time.Now, store: store, open: map[string]*openWait{}}
}

// SetAgents wires the counter to the agents (rt for the screens, discover for who is running) and to the teams.
func (c *LimitCounter) SetAgents(rt AgentRuntime, discover func(context.Context) ([]AgentInfo, error), teamOf func(context.Context) map[string]string) {
	c.discover = discover
	c.teamOf = teamOf
	c.state = limitStateReader(rt)
}

// limitStateReader reads whether an agent is stopped by a usage limit and when it resets, from the same sources as the live row's usage_limit mark.
func limitStateReader(rt AgentRuntime) func(ctx context.Context, a AgentInfo, now time.Time) (time.Time, bool) {
	screen := screenLimit(rt)
	reader := jsonl.NewSessionReader()
	return func(ctx context.Context, a AgentInfo, now time.Time) (time.Time, bool) {
		switch a.AgentType {
		case at.Claude, "":
			e, ok := reader.ReadClaudeAPIError(a.SessionID, a.WorkingDirectory)
			if !ok || !e.UsageLimit() {
				return time.Time{}, false
			}
			reset, _ := e.ResetsAt()
			return reset, true
		case at.Codex, at.Agy, at.Antigravity:
			if screen == nil {
				return time.Time{}, false
			}
			screen(ctx, a) // reads the screen (cached a few seconds) and marks the limit
			return ptymanager.UsageLimitOf(a.SessionID, limitMarkMaxAge, now)
		}
		return time.Time{}, false
	}
}

// Run looks every interval until ctx ends.
func (c *LimitCounter) Run(ctx context.Context) error {
	return runOnTicker(ctx, c.interval, func() { c.Tick(ctx) })
}

func vendorOf(agentType string) string {
	switch agentType {
	case at.Codex:
		return "codex"
	case at.Agy, at.Antigravity:
		return "agy"
	}
	return "claude"
}

// Tick is one look: it opens the waits of agents newly stopped by a limit and closes the ones whose agent works again or went away.
func (c *LimitCounter) Tick(ctx context.Context) {
	if c.discover == nil || c.state == nil || c.store == nil {
		return
	}
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.loaded {
		c.loaded = true
		if waits, err := c.store.Open(); err == nil {
			for _, w := range waits {
				c.open[w.SessionID] = &openWait{id: w.ID, resetAt: w.ResetAt}
			}
		} else {
			c.logger.Warn("limit counter: the open waits could not be read", "err", err)
		}
	}
	agents, err := c.discover(ctx)
	if err != nil {
		return
	}
	var teams map[string]string
	if c.teamOf != nil {
		teams = c.teamOf(ctx)
	}
	live := map[string]AgentInfo{}
	for _, a := range agents {
		live[a.SessionID] = a
	}
	// an open wait whose agent is not there: ended as gone after it has been missing two looks in a row
	for sid, w := range c.open {
		if _, ok := live[sid]; ok {
			continue
		}
		if !w.gone || w.missed == 0 {
			w.missed, w.missedAt, w.gone = 0, now, true
		}
		w.missed++
		if w.missed >= limitCounterMisses {
			c.end(sid, w, w.missedAt, limitwaits.EndedGone)
		}
	}
	for _, a := range agents {
		if a.SessionID == "" {
			continue
		}
		reset, limited := c.state(ctx, a, now)
		w := c.open[a.SessionID]
		switch {
		case limited && w != nil:
			w.missed, w.gone = 0, false
			if !reset.IsZero() && !sameReset(w.resetAt, reset) {
				if !w.resetAt.IsZero() && !now.Before(w.resetAt) && now.Sub(reset) <= limitResumeLate {
					// the first limit's reset has come and the agent hit another limit since: the first ended at its reset, this is a new wait
					c.end(a.SessionID, w, w.resetAt, limitwaits.EndedAtReset)
					c.begin(a, reset, now, teams)
				} else {
					w.resetAt = reset // the reset moved before it came (a new login, a screen that drifts): the same wait
				}
			}
		case limited && w == nil:
			if !reset.IsZero() && now.Sub(reset) > limitResumeLate {
				continue // an old error left in a transcript, not a wait
			}
			c.begin(a, reset, now, teams)
		case !limited && w != nil:
			if w.gone || w.missed == 0 {
				w.missed, w.missedAt, w.gone = 0, now, false
			}
			w.missed++
			if w.missed >= limitCounterMisses {
				c.end(a.SessionID, w, w.missedAt, c.endedBy(w, w.missedAt))
			}
		}
	}
}

// endedBy says how a wait whose agent is working again at t ended: at the reset (or after it) or early. A wait with no reset time cannot be told either way.
func (c *LimitCounter) endedBy(w *openWait, t time.Time) string {
	if w.resetAt.IsZero() {
		return limitwaits.EndedUnknown
	}
	if !t.Before(w.resetAt.Add(-resetTolerance)) {
		return limitwaits.EndedAtReset
	}
	return limitwaits.EndedEarly
}

func (c *LimitCounter) begin(a AgentInfo, reset, now time.Time, teams map[string]string) {
	name := a.DisplayName
	if name == "" {
		name = a.AgentName
	}
	w := limitwaits.Wait{SessionID: a.SessionID, Agent: name, Team: teams[naming.SessionName(a.AgentType, a.SessionID)], Vendor: vendorOf(a.AgentType), StartedAt: now, ResetAt: reset}
	id, err := c.store.Begin(w)
	if err != nil {
		c.logger.Warn("limit counter: a wait could not be recorded", "session_id", a.SessionID, "err", err)
		return
	}
	c.open[a.SessionID] = &openWait{id: id, resetAt: reset}
}

func (c *LimitCounter) end(sid string, w *openWait, at time.Time, kind string) {
	delete(c.open, sid)
	if err := c.store.End(w.id, at, kind); err != nil {
		c.logger.Warn("limit counter: the end of a wait could not be recorded", "session_id", sid, "err", err)
	}
}
