package resources

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// The shell hook of the resource queue (#13645, goal #225): a Bash call whose command matches a resource's patterns claims a slot of it first, holds it while the call (and anything the call started that
// still runs) lives, and gives it back after. Opt-in per resource: a resource with no patterns is never touched. It is a guard against overlapping heavy runs, not a gate: any error, an unreadable command,
// an agent that is on no board, a queue that is off, lets the call run.
//
// Never the command: the queue's note, the refusal text and the events carry the MATCHED PATTERN, which the manager wrote, because a command line holds secrets and text another agent chose (Security).

// HookOptions are what a Hook is made from; the zero value of each optional field is a sensible default.
type HookOptions struct {
	// Agent is the board member name of an agent session by its session NAME (the name its explicit claims carry), ok false when the session is on no board.
	Agent func(ctx context.Context, session string) (string, bool)
	// Commands are the command lines of the processes the session's agent has started that are still running; nil: not known, so a slot is given back when the call ends.
	Commands func(name string) []string
	Now      func() time.Time
	// ClaimWindow is how long a slot granted to a waiting auto-claim waits for its agent to run something before it passes to the next in line (default 2 minutes).
	ClaimWindow time.Duration
	// Event is told of each auto-claim, refusal and release (the Operator's Activity); nil: nothing is told.
	Event func(HookEvent)
}

// HookEvent says what the hook did. Pattern is the manager's pattern, never the command.
type HookEvent struct {
	Kind     string // "claimed", "refused", "released"
	Resource string
	Pattern  string
	Agent    string
	Session  string
	Why      string // for a release: "call ended", "unclaimed", "cap", "gone"
}

type holdKey struct{ resource, agent string }

type autoHold struct {
	entry   int64
	session string // the session id
	name    string // its name
	pattern string
	calls   map[string]bool // tool_use ids of the matched calls still running
	refused map[string]bool // tool_use ids of the matched calls this hook held: a CLI that ran one anyway says so at its end (#13647)
	granted time.Time       // first seen holding the slot
	window  time.Time       // before this a slot with no call yet is kept for its agent
}

// Hook is the shell hook's state: which auto-claims are held for which calls.
type Hook struct {
	m    *Manager
	o    HookOptions
	mu   sync.Mutex
	hold map[holdKey]*autoHold
}

// NewHook makes the hook over a Manager.
func NewHook(m *Manager, o HookOptions) *Hook {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.ClaimWindow <= 0 {
		o.ClaimWindow = 2 * time.Minute
	}
	return &Hook{m: m, o: o, hold: map[holdKey]*autoHold{}}
}

func (h *Hook) event(e HookEvent) {
	if h.o.Event != nil {
		h.o.Event(e)
	}
}

// Before is called for a Bash call about to run: session is the session's id (what After and SessionEnded are given), name its name on the board and in the terminal. It returns the text to refuse the call with, or "" to let it run.
func (h *Hook) Before(ctx context.Context, session, name, toolUseID, command string) (refuse string) {
	if h == nil || h.m == nil || h.o.Agent == nil {
		return ""
	}
	agent, ok := h.o.Agent(ctx, name)
	if !ok || agent == "" {
		return ""
	}
	var res resourcequeue.Resource
	pattern := ""
	for _, st := range h.m.Queue().All() {
		if p, hit := MatchCommand(command, st.Resource.Match); hit {
			res, pattern = st.Resource, p
			break
		}
	}
	if pattern == "" {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	key := holdKey{res.Key, agent}
	st, err := h.m.Queue().Status(res.Key)
	if err != nil {
		return ""
	}
	// already in the line or holding?
	mine, holding := entryOf(st, agent)
	if mine != nil && holding {
		if ah := h.hold[key]; ah != nil {
			ah.calls[toolUseID] = true
			ah.session = session
			if ah.granted.IsZero() { // granted since it queued, and the agent came back with the command: no claim window any more
				ah.granted = mine.Granted
			}
			ah.window = time.Time{}
			_, _ = h.m.Queue().Renew(res.Key, agent)
		} // an explicit claim keeps its slot until the agent releases it: nothing to track
		return ""
	}
	if mine == nil {
		r, err := h.m.Claim(ctx, res.Key, agent, "auto: "+pattern)
		if err != nil {
			return "" // queue trouble never stops a command
		}
		ah := &autoHold{entry: r.Entry.ID, session: session, name: name, pattern: pattern, calls: map[string]bool{}, refused: map[string]bool{}}
		h.hold[key] = ah
		if r.Granted {
			ah.calls[toolUseID] = true
			ah.granted = h.o.Now()
			h.event(HookEvent{Kind: "claimed", Resource: res.Key, Pattern: pattern, Agent: agent, Session: session})
			return ""
		}
		ah.refused[toolUseID] = true
		h.event(HookEvent{Kind: "refused", Resource: res.Key, Pattern: pattern, Agent: agent, Session: session})
		return refusal(res.Key, r.Place)
	}
	// in the line already (this agent's earlier refused call, or an explicit claim): still waiting
	if ah := h.hold[key]; ah != nil {
		ah.session = session
		if ah.refused == nil {
			ah.refused = map[string]bool{}
		}
		ah.refused[toolUseID] = true
	}
	_, place := placeOf(st, agent)
	h.event(HookEvent{Kind: "refused", Resource: res.Key, Pattern: pattern, Agent: agent, Session: session})
	return refusal(res.Key, place)
}

func refusal(resource string, place int) string {
	return fmt.Sprintf("Coral held this command: %s is busy and you are number %d in line. Run: coral-board resource claim %s --wait   (it waits for your turn; then run the command again). "+
		"Or run the same command again later: your place in line is kept. Do not retry in a loop.", resource, place, resource)
}

func entryOf(st resourcequeue.Status, agent string) (*resourcequeue.Entry, bool) {
	for i := range st.Holders {
		if strings.EqualFold(st.Holders[i].Agent, agent) {
			return &st.Holders[i], true
		}
	}
	for i := range st.Queue {
		if strings.EqualFold(st.Queue[i].Agent, agent) {
			return &st.Queue[i], false
		}
	}
	return nil, false
}

func placeOf(st resourcequeue.Status, agent string) (*resourcequeue.Entry, int) {
	for i := range st.Queue {
		if strings.EqualFold(st.Queue[i].Agent, agent) {
			return &st.Queue[i], i + 1
		}
	}
	return nil, 0
}

// After is called when a Bash call ended (PostToolUse): the slot it held goes back, unless the call started work that still runs or the agent has other matched calls running.
func (h *Hook) After(session, toolUseID string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, ah := range h.hold {
		if ah.session != session {
			continue
		}
		delete(ah.calls, toolUseID)
		if ah.refused[toolUseID] { // a call this hook held has ended: the CLI ran it anyway (it ignored the refusal). Its work runs, so its waiting place goes; a place that was granted since is its own, and stays
			delete(ah.refused, toolUseID)
			if st, err := h.m.Queue().Status(k.resource); err == nil {
				if _, holding := entryOf(st, k.agent); !holding {
					h.releaseLocked(k, ah, "ran anyway")
				}
			}
		}
	}
	h.sweepLocked()
}

// SessionEnded gives back every auto-claim of the session (it stopped, or was reset or ended).
func (h *Hook) SessionEnded(session string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, ah := range h.hold {
		if ah.session == session {
			h.releaseLocked(k, ah, "gone")
		}
	}
}

// Sweep ends what should end: an auto-claim whose queue entry is gone, one held past twice the resource's lease (a PostToolUse that never came cannot keep a slot forever), one granted to a waiter whose agent
// ran nothing in the claim window, and one with no call running and nothing it started still running. What still runs keeps the lease renewed.
func (h *Hook) Sweep() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
}

func (h *Hook) sweepLocked() {
	now := h.o.Now()
	for k, ah := range h.hold {
		st, err := h.m.Queue().Status(k.resource)
		if err != nil {
			delete(h.hold, k)
			continue
		}
		var e *resourcequeue.Entry
		holding := false
		for i := range st.Holders {
			if st.Holders[i].ID == ah.entry {
				e, holding = &st.Holders[i], true
			}
		}
		for i := range st.Queue {
			if st.Queue[i].ID == ah.entry {
				e = &st.Queue[i]
			}
		}
		if e == nil { // reaped, kicked or removed
			delete(h.hold, k)
			continue
		}
		if !holding {
			continue
		}
		if ah.granted.IsZero() { // granted to a waiter since: it has the claim window, from the moment the slot came up, to run something
			ah.granted = e.Granted
			ah.window = e.Granted.Add(h.o.ClaimWindow)
		}
		lease := st.Resource.MaxLease
		if lease <= 0 {
			lease = resourcequeue.DefaultLease
		}
		if now.Sub(ah.granted) > 2*lease {
			h.releaseLocked(k, ah, "cap")
			continue
		}
		if len(ah.calls) > 0 || h.startedWorkRuns(ah, st.Resource) {
			_, _ = h.m.Queue().Renew(k.resource, k.agent)
			continue
		}
		if !ah.window.IsZero() && now.Before(ah.window) {
			continue // granted to a waiter: its agent has a moment to run the command again
		}
		why := "call ended"
		if !ah.window.IsZero() {
			why = "unclaimed"
		}
		h.releaseLocked(k, ah, why)
	}
}

// startedWorkRuns reports whether a process the session's agent started, and that matches the resource's patterns, still runs: a call that returned while its work goes on (an &, nohup, a script that forks the suite)
// keeps the slot until that work is gone.
func (h *Hook) startedWorkRuns(ah *autoHold, res resourcequeue.Resource) bool {
	if h.o.Commands == nil {
		return false
	}
	for _, c := range h.o.Commands(ah.name) {
		if _, hit := MatchCommand(c, res.Match); hit {
			return true
		}
	}
	return false
}

func (h *Hook) releaseLocked(k holdKey, ah *autoHold, why string) {
	_ = h.m.Queue().Release(k.resource, k.agent)
	delete(h.hold, k)
	h.event(HookEvent{Kind: "released", Resource: k.resource, Pattern: ah.pattern, Agent: k.agent, Session: ah.session, Why: why})
}
