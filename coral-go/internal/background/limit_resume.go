package background

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// LimitResumer resumes an agent that a usage limit stopped, when the limit resets (#20691, goal #279 feature B). Behind the setting auto_resume_at_limit_reset, off by default.
//   - Only a reset time the CLI itself printed counts (Claude's transcript error, Codex's and agy's screens). No time, no resume: the agent stays as it is.
//   - One resume per limit event: an event is a session and its reset time. A resume sent, or cancelled, is never made again for the same event.
//   - The resume goes at the reset plus a delay that staggers the agents of one account: the agents that wait for the same reset (same CLI, same reset minute) go one after another, TeamGap-ish apart,
//     each with its own ±20% jitter (#3613's rule), and the send itself goes through the automated-input gate, which spaces a team's sends too.
//   - A manual action cancels it: a person typing to the agent after the resume was planned, the agent working again on its own, or the agent gone.
//   - The same caps as the API-error resume: three resumes per agent, then Coral stops until a person has typed to it; a day later the count is forgotten.
//   - The pending time is in the live list (limit_resume_at) for the limit view.
type LimitResumer struct {
	interval time.Duration
	logger   *slog.Logger
	now      func() time.Time

	discover func(ctx context.Context) ([]AgentInfo, error)
	// limitAt is when a's limit resets, per the CLI's own words; false: a is not stopped by a limit, or no time is known.
	limitAt func(ctx context.Context, a AgentInfo, now time.Time) (time.Time, bool)
	// enabled reads the setting.
	enabled func(ctx context.Context) bool
	// working says the agent is in a turn of its own (it resumed by itself): nothing is typed into a turn.
	working func(ctx context.Context, sessionID string) bool
	// touched says a person typed to the session since t.
	touched func(sessionID string, since time.Time) bool
	deliver func(ctx context.Context, a AgentInfo, text string) error

	mu      sync.Mutex
	pending map[string]*limitPending // by session id
	done    map[string]time.Time     // limit events dealt with (sent or cancelled), by event key, when
	slots   map[string]int           // agents already planned for one account's reset (group key)
	sent    map[string][]time.Time   // resumes sent per session id, inside capWindow
}

type limitPending struct {
	a       AgentInfo
	event   string
	resetAt time.Time
	at      time.Time // when it goes
	since   time.Time // when it was planned: a person's input after this cancels it
}

const (
	// limitResumeText is what the agent is told: one fixed notice (it starts with a notice opener, nothing in it comes from the agent, a message or a transcript) that tells it to continue.
	limitResumeText = "[Coral] Your usage limit has reset. Please continue where you stopped."
	limitResumeBase = 15 * time.Second // after the reset, before the first agent of an account
	limitResumeGap  = 10 * time.Second // between two agents of one account
	// limitResumeLate: a limit whose reset is older than this is not an event Coral resumes (an old error left in a transcript).
	limitResumeLate      = 30 * time.Minute
	limitResumeCap       = 3 // resumes per agent inside limitResumeCapWindow, as many as the API-error resume tries
	limitResumeCapWindow = 24 * time.Hour
)

// NewLimitResumer is a resumer that looks every interval (a minute when 0).
func NewLimitResumer(interval time.Duration) *LimitResumer {
	if interval <= 0 {
		interval = time.Minute
	}
	return &LimitResumer{interval: interval, logger: slog.Default().With("service", "limit_resume"), now: time.Now,
		pending: map[string]*limitPending{}, done: map[string]time.Time{}, slots: map[string]int{}, sent: map[string][]time.Time{}}
}

// SetAgents wires the resumer to the agents: rt for screens and typing, discover for who is running, ts for who works, enabled for the setting.
func (r *LimitResumer) SetAgents(ts *store.TaskStore, rt AgentRuntime, discover func(context.Context) ([]AgentInfo, error), enabled func(context.Context) bool) {
	r.discover = discover
	r.enabled = enabled
	screen := screenLimit(rt)
	reader := jsonl.NewSessionReader()
	r.limitAt = func(ctx context.Context, a AgentInfo, now time.Time) (time.Time, bool) {
		switch a.AgentType {
		case at.Claude, "":
			e, ok := reader.ReadClaudeAPIError(a.SessionID, a.WorkingDirectory)
			if !ok {
				return time.Time{}, false
			}
			return e.ResetsAt()
		case at.Codex, at.Agy, at.Antigravity:
			if screen == nil {
				return time.Time{}, false
			}
			d, blocked := screen(ctx, a)
			if !blocked || d <= 0 {
				return time.Time{}, false // no limit, or one with no time on the screen (a refused model has none): nothing to wait for
			}
			return now.Add(d), true
		}
		return time.Time{}, false
	}
	signal := hookSignal(ts)
	r.working = func(ctx context.Context, sid string) bool {
		sig, known := signal(ctx, sid)
		return known && sig.InTurn
	}
	r.touched = func(sid string, since time.Time) bool { return personTypedSince(sid, since) }
	r.deliver = func(ctx context.Context, a AgentInfo, text string) error {
		_, err := deliverAutomated(ctx, rt, r.logger, naming.SessionName(a.AgentType, a.SessionID), a.AgentType, a.SessionID, text, "limit reset resume", false, false)
		return err
	}
}

func personTypedSince(sid string, since time.Time) bool {
	return terminalinput.PersonTypedSince(sid, since)
}

// Run looks every interval until ctx ends.
func (r *LimitResumer) Run(ctx context.Context) error {
	return runOnTicker(ctx, r.interval, func() { r.Tick(ctx) })
}

// resetTolerance: two readings of one limit's reset this close are the same event.
const resetTolerance = 2 * time.Minute

func sameReset(a, b time.Time) bool {
	d := a.Sub(b)
	return d >= -resetTolerance && d <= resetTolerance
}

func limitEvent(sid string, reset time.Time) string {
	return fmt.Sprintf("%s@%d", sid, reset.Unix()/60)
}

// Tick is one look: it plans the resumes of agents newly stopped by a limit, cancels the ones that no longer apply and sends the ones that are due.
func (r *LimitResumer) Tick(ctx context.Context) {
	if r.discover == nil || r.limitAt == nil || r.enabled == nil {
		return
	}
	now := r.now()
	if !r.enabled(ctx) {
		r.forgetAllPending()
		return
	}
	agents, err := r.discover(ctx)
	if err != nil {
		return
	}
	live := map[string]AgentInfo{}
	for _, a := range agents {
		live[a.SessionID] = a
	}
	r.mu.Lock()
	for sid, p := range r.pending { // an agent that went away (stopped, asleep) is not resumed here
		if _, ok := live[sid]; !ok {
			r.cancelLocked(sid, p, now)
		}
	}
	r.pruneLocked(now)
	r.mu.Unlock()

	var due []*limitPending
	for _, a := range agents {
		reset, ok := r.limitAt(ctx, a, now)
		r.mu.Lock()
		p := r.pending[a.SessionID]
		switch {
		case ok && p != nil && sameReset(p.resetAt, reset):
			// planned already (a reset read off a screen as "in 3 h" drifts by seconds between looks: the same event)
		case ok && p != nil && now.Before(p.resetAt):
			r.cancelLocked(a.SessionID, p, now) // the reset moved: the old plan is dropped, and the new one is made below
			p = nil
			fallthrough
		case ok && p == nil:
			if now.Sub(reset) <= limitResumeLate {
				r.planLocked(a, reset, now)
			}
		case !ok && p != nil && now.Before(p.resetAt):
			r.cancelLocked(a.SessionID, p, now) // the limit is gone before its reset (a new login, a manual resume): nothing to do
		}
		// a notice that stops reading as a limit once the reset has come is the reset: the plan stays and goes
		if p = r.pending[a.SessionID]; p != nil && !now.Before(p.at) {
			due = append(due, p)
		}
		r.mu.Unlock()
	}
	for _, p := range due {
		r.resume(ctx, p, now)
	}
}

// planLocked plans a's resume for the limit that resets at reset, unless this event was dealt with or the agent has used its resumes.
func (r *LimitResumer) planLocked(a AgentInfo, reset, now time.Time) {
	ev := limitEvent(a.SessionID, reset)
	for d := -resetTolerance; d <= resetTolerance; d += time.Minute {
		if _, dealt := r.done[limitEvent(a.SessionID, reset.Add(d))]; dealt {
			return
		}
	}
	if sent := r.sent[a.SessionID]; len(sent) > 0 && r.touched != nil && r.touched(a.SessionID, sent[len(sent)-1]) {
		r.sent[a.SessionID] = nil // a person has typed to it since Coral's last resume: the count starts again
	}
	if r.sentInWindowLocked(a.SessionID, now) >= limitResumeCap {
		r.done[ev] = now
		r.logger.Info("limit resume: not planned, the agent has used its resumes", "session_id", a.SessionID)
		return
	}
	group := a.AgentType + "|" + fmt.Sprint(reset.Unix()/60)
	n := r.slots[group]
	r.slots[group] = n + 1
	delay := ptymanager.JitterAround(limitResumeBase, group) // the account's agents share this start, so their order is their slot's
	for i := 1; i <= n; i++ {
		delay += ptymanager.JitterAround(limitResumeGap, fmt.Sprintf("%s/%d", group, i)) // each slot a gap (8 to 12 s) after the one before
	}
	p := &limitPending{a: a, event: ev, resetAt: reset, at: reset.Add(delay), since: now}
	r.pending[a.SessionID] = p
	ptymanager.NoteLimitResume(a.SessionID, p.at)
}

func (r *LimitResumer) sentInWindowLocked(sid string, now time.Time) int {
	keep := r.sent[sid][:0]
	for _, t := range r.sent[sid] {
		if now.Sub(t) < limitResumeCapWindow {
			keep = append(keep, t)
		}
	}
	r.sent[sid] = keep
	return len(keep)
}

// cancelLocked drops a plan; the event is dealt with, so it is not planned again.
func (r *LimitResumer) cancelLocked(sid string, p *limitPending, now time.Time) {
	delete(r.pending, sid)
	r.done[p.event] = now
	ptymanager.NoteLimitResume(sid, time.Time{})
}

func (r *LimitResumer) forgetAllPending() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for sid := range r.pending {
		ptymanager.NoteLimitResume(sid, time.Time{})
	}
	r.pending = map[string]*limitPending{}
	r.slots = map[string]int{}
}

// pruneLocked keeps the books small: old events and the account slots of resets long past.
func (r *LimitResumer) pruneLocked(now time.Time) {
	for ev, t := range r.done {
		if now.Sub(t) > 48*time.Hour {
			delete(r.done, ev)
		}
	}
	if len(r.pending) == 0 {
		r.slots = map[string]int{}
	}
}

// resume sends the resume of a due plan, unless a person has acted or the agent works again.
func (r *LimitResumer) resume(ctx context.Context, p *limitPending, now time.Time) {
	sid := p.a.SessionID
	r.mu.Lock()
	cur := r.pending[sid]
	if cur != p {
		r.mu.Unlock()
		return
	}
	if r.touched != nil && r.touched(sid, p.since) {
		r.cancelLocked(sid, p, now) // a person acted: theirs to decide now
		r.mu.Unlock()
		r.logger.Info("limit resume: cancelled, a person typed to the agent", "session_id", sid)
		return
	}
	r.mu.Unlock()
	if r.working != nil && r.working(ctx, sid) {
		r.mu.Lock()
		r.cancelLocked(sid, p, now) // it is in a turn of its own: not typed into
		r.mu.Unlock()
		r.logger.Info("limit resume: cancelled, the agent works again", "session_id", sid)
		return
	}
	// Counted and closed before the send: one resume per limit event, whatever the send does.
	r.mu.Lock()
	r.cancelLocked(sid, p, now)
	r.sent[sid] = append(r.sent[sid], now)
	r.mu.Unlock()
	if err := r.deliver(ctx, p.a, limitResumeText); err != nil {
		r.logger.Warn("limit resume: not sent", "session_id", sid, "err", err)
		return
	}
	r.logger.Info("limit resume: sent", "session_id", sid)
}

// AutoResumeAtLimitResetEnabled reads the setting from the stored settings map.
func AutoResumeAtLimitResetEnabled(settings map[string]string) bool {
	return setreg.Bool(settings, setreg.AutoResumeAtLimitReset)
}
