package resources

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/proctree"
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
	// Procs lists the machine's processes (ps), for a hand claim's work (#13718); ok false: not known, and a claim then follows its tool call alone. nil: the claim follows its call alone.
	Procs func() ([]proctree.Proc, bool)
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

// handBind is what a hand claim (coral-board resource claim, run by an agent) is tied to: the tool call it was made in and, for a job that outlives the call (Claude's run_in_background, Codex's background terminal), the work
// the call started under the claiming shell.
type handBind struct {
	session string          // the session id
	calls   map[string]bool // the tool calls in flight when the claim was made (it is one of them: a client cannot say which, so the claim waits for all of them)
	shell   int             // the shell that ran the claim, in the agent's own process tree (0: not known or not believed: the claim follows its call alone)
	shellAt string          // that shell's command line at the claim: a shell that exec'd the job has another one later
	before  map[int]bool    // the processes below the shell at the claim: older jobs of a persistent shell are not this call's work
	ended   bool            // the call (or its turn) has ended: the slot goes back as soon as the work is gone too
}

// BindHand ties the hold or place agent has of resource to the tool call it was claimed in (#13718, the Operator: "coral tracks the tool call the agent does and when it's finished, release the slot"), and to the work the call
// starts under the claiming shell `shell` (the CLI's parent; believed only when it is in agentPID's own process tree). The slot goes back when the call has ended AND that work is gone: a foreground command ends both together,
// a background job keeps the slot for as long as it runs (a persistent shell's older jobs do not count), a crashed agent's session frees it. A forgotten release cannot hold the line. A claim with no tool call (the Operator's
// command line) is never bound: it keeps its lease. The lease still ends any claim.
func (h *Hook) BindHand(session, agent, resource string, toolCalls []string, shell, agentPID int) {
	b := handBind{session: session, calls: map[string]bool{}}
	for _, c := range toolCalls {
		if c != "" {
			b.calls[c] = true
		}
	}
	if h == nil || session == "" || len(b.calls) == 0 { // no known call: nothing to tie it to, the lease alone ends it
		return
	}
	if shell > 1 && agentPID > 1 && h.o.Procs != nil {
		if procs, ok := h.o.Procs(); ok { // ps, never under the lock
			if _, inTree := findBelow(procs, agentPID, shell); inTree {
				me, _ := proctree.Find(procs, shell)
				b.shell, b.shellAt, b.before = shell, me.Command, map[int]bool{}
				for _, d := range proctree.Descendants(procs, shell) {
					b.before[d.PID] = true
				}
			}
		}
	}
	h.mu.Lock()
	h.hand[holdKey{resource, agent}] = b
	h.mu.Unlock()
}

// findBelow finds pid among the processes below root.
func findBelow(procs []proctree.Proc, root, pid int) (proctree.Proc, bool) {
	for _, p := range proctree.Descendants(procs, root) {
		if p.PID == pid {
			return p, true
		}
	}
	return proctree.Proc{}, false
}

// workRuns says whether what the call started under the bound shell still runs: the shell became the job (another command line), or a process that was not there at the claim is below it.
func (b handBind) workRuns(procs []proctree.Proc) bool {
	if b.shell <= 1 {
		return false
	}
	me, alive := proctree.Find(procs, b.shell)
	if !alive {
		return false
	}
	if me.Command != b.shellAt {
		return true
	}
	for _, d := range proctree.Descendants(procs, b.shell) {
		if !b.before[d.PID] {
			return true
		}
	}
	return false
}

// handsWork reads the process list once (never under the lock), only when some ended hand claim has a shell to look at.
func (h *Hook) handsWork(want func(handBind) bool) ([]proctree.Proc, bool) {
	if h.o.Procs == nil {
		return nil, false
	}
	h.mu.Lock()
	need := false
	for _, b := range h.hand {
		if b.shell > 1 && want(b) {
			need = true
			break
		}
	}
	h.mu.Unlock()
	if !need {
		return nil, false
	}
	return h.o.Procs()
}

// endHands says that the call (or, with call "", the whole turn) of the session has ended: each of its hand claims whose work is gone goes back now, the rest when it is (Sweep).
func (h *Hook) endHands(session, call, why string) {
	procs, known := h.handsWork(func(b handBind) bool { return b.session == session && (call == "" || b.calls[call]) })
	h.mu.Lock()
	var gone []holdKey
	for k, b := range h.hand {
		if b.session != session || (call != "" && !b.calls[call]) {
			continue
		}
		if call != "" {
			delete(b.calls, call) // one of the calls it waits for ended
			if len(b.calls) > 0 {
				continue // others that were in flight with the claim have not: it may be theirs
			}
		}
		if known && b.workRuns(procs) {
			b.ended = true
			h.hand[k] = b
			continue
		}
		gone = append(gone, k)
		delete(h.hand, k)
	}
	h.mu.Unlock()
	h.giveBack(gone, why)
}

func (h *Hook) giveBack(keys []holdKey, why string) {
	for _, k := range keys {
		grace := resourcequeue.DefaultAwayGrace // a place still in line is kept for a grace when the wait ended without a turn (#13706); a slot held is given back; an agent that is GONE keeps nothing
		if why == "gone" {
			grace = 0
		}
		if err := h.m.Queue().Leave(k.resource, k.agent, grace); err == nil { // already released by hand: nothing to do
			h.event(HookEvent{Kind: "released", Resource: k.resource, Agent: k.agent, Why: why})
		}
	}
}

// sweepHands gives back the hand claims that have ended and whose work is gone, and forgets those whose slot or place is no longer there (a lease ran out, a person kicked it).
func (h *Hook) sweepHands() {
	procs, known := h.handsWork(func(b handBind) bool { return b.ended })
	h.mu.Lock()
	var gone []holdKey
	for k, b := range h.hand {
		if b.ended && !(known && b.workRuns(procs)) {
			gone = append(gone, k)
			delete(h.hand, k)
			continue
		}
		if st, err := h.m.Queue().Status(k.resource); err != nil || !hasEntry(st, k.agent) {
			delete(h.hand, k)
		}
	}
	h.mu.Unlock()
	h.giveBack(gone, "job ended")
}

func hasEntry(st resourcequeue.Status, agent string) bool {
	for _, e := range st.Holders {
		if e.Agent == agent {
			return true
		}
	}
	for _, e := range st.Queue {
		if e.Agent == agent {
			return true
		}
	}
	return false
}

// TurnEnded is the end of the session's turn: the safety net for a tool call that never reported its end.
func (h *Hook) TurnEnded(session string) {
	if h == nil {
		return
	}
	h.endHands(session, "", "turn ended")
}

// Hook is the shell hook's state: which auto-claims are held for which calls.
type Hook struct {
	m    *Manager
	o    HookOptions
	mu   sync.Mutex
	hold map[holdKey]*autoHold
	hand map[holdKey]handBind // slots an agent claimed by hand, each tied to the tool call it was claimed in (#13718)

	pmu   sync.Mutex // the process lists below, never held while a list is read
	procs map[string]*procEntry
}

// procEntry is the last process list read for a session name. Reading one runs ps (up to 3 s), so it is never done under the hook's lock, is reused for procTTL, and a read already under way is not waited for:
// the stale list (or, with none, "still running") answers instead, so one slow ps never holds up another agent's Bash call.
type procEntry struct {
	cmds     []string
	at       time.Time
	inflight bool
}

const procTTL = 3 * time.Second

// Active reports whether any resource has a match: with none the hook has nothing to do, and a caller skips every lookup before it.
func (h *Hook) Active() bool {
	if h == nil || h.m == nil {
		return false
	}
	return h.m.Queue().AnyMatch()
}

// NewHook makes the hook over a Manager.
func NewHook(m *Manager, o HookOptions) *Hook {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.ClaimWindow <= 0 {
		o.ClaimWindow = 2 * time.Minute
	}
	return &Hook{m: m, o: o, hold: map[holdKey]*autoHold{}, hand: map[holdKey]handBind{}, procs: map[string]*procEntry{}}
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
	if !ok {
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
	snap := h.snapshot()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked(snap)
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
	if mine != nil && !mine.Away.IsZero() { // the agent is back with the command (#13706): its kept place is its own again, no grace runs on it
		_, _ = h.m.Queue().Claim(res.Key, resourcequeue.Claimant{Agent: agent})
	}
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
	h.endHands(session, toolUseID, "call ended")
	h.mu.Lock()
	for k, ah := range h.hold {
		if ah.session != session {
			continue
		}
		delete(ah.calls, toolUseID)
		if ah.refused[toolUseID] { // a call this hook held has ended: the CLI ran it anyway (it ignored the refusal). Its work runs, so its waiting place goes; a place that was granted since is its own, and stays (#13647)
			delete(ah.refused, toolUseID)
			if st, err := h.m.Queue().Status(k.resource); err == nil {
				if _, holding := entryOf(st, k.agent); !holding {
					h.releaseLocked(k, ah, "ran anyway")
				}
			}
		}
	}
	h.mu.Unlock()
	snap := h.snapshot() // after the call is gone from the hold: its session is then one the sweep asks about
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked(snap)
}

// SessionEnded gives back every auto-claim of the session (it stopped, or was reset or ended).
func (h *Hook) SessionEnded(session string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	var gone []holdKey
	for k, b := range h.hand {
		if b.session == session {
			gone = append(gone, k)
			delete(h.hand, k)
		}
	}
	h.mu.Unlock()
	h.giveBack(gone, "gone") // the agent is gone: its jobs are not a reason to keep the slot
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
	h.sweepHands()
	snap := h.snapshot()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked(snap)
}

// snapshot reads, outside the lock, the process lists of the sessions whose holds have no call running (the only ones the sweep asks about).
func (h *Hook) snapshot() map[string][]string {
	if h.o.Commands == nil {
		return nil
	}
	h.mu.Lock()
	var names []string
	for _, ah := range h.hold {
		if len(ah.calls) == 0 {
			names = append(names, ah.name)
		}
	}
	h.mu.Unlock()
	out := map[string][]string{}
	for _, n := range names {
		out[n] = h.processes(n)
	}
	return out
}

// processes is the session's running command lines: the cached list while it is fresh, a fresh read otherwise, and the stale list when a read is already under way.
func (h *Hook) processes(name string) []string {
	h.pmu.Lock()
	e := h.procs[name]
	if e == nil {
		e = &procEntry{}
		h.procs[name] = e
	}
	if !e.at.IsZero() && h.o.Now().Sub(e.at) < procTTL {
		c := e.cmds
		h.pmu.Unlock()
		return c
	}
	if e.inflight {
		c := e.cmds
		unknown := e.at.IsZero()
		h.pmu.Unlock()
		if unknown {
			return []string{unknownRunning} // no list yet: the work is assumed to run, so a slot is never freed on a guess
		}
		return c
	}
	e.inflight = true
	h.pmu.Unlock()
	cmds := h.o.Commands(name)
	h.pmu.Lock()
	e.cmds, e.at, e.inflight = cmds, h.o.Now(), false
	h.pmu.Unlock()
	return cmds
}

// unknownRunning stands for a process list that is not known yet; it matches whatever the resource's patterns are (see startedWorkRuns).
const unknownRunning = "\x00unknown"

func (h *Hook) sweepLocked(snap map[string][]string) {
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
		if len(ah.calls) > 0 || h.startedWorkRuns(ah, st.Resource, snap) {
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
func (h *Hook) startedWorkRuns(ah *autoHold, res resourcequeue.Resource, snap map[string][]string) bool {
	if h.o.Commands == nil {
		return false
	}
	cmds, ok := snap[ah.name]
	if !ok { // the hold had a call running when the lists were read: use the last list, never a read under the lock
		h.pmu.Lock()
		if e := h.procs[ah.name]; e != nil {
			cmds = e.cmds
		}
		h.pmu.Unlock()
	}
	for _, c := range cmds {
		if c == unknownRunning {
			return true
		}
		if !strings.ContainsAny(c, " \t") && MatchImage(c, res.Match) { // a bare program name: a list with no command lines (Windows)
			return true
		}
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
