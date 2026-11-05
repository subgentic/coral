// Package resourcequeue is a queue of agents for named resources with a number of slots (#13380-adjacent, the Operator's "resource queue", plan v2): a resource such as "mac-heavy" has N slots; an agent
// claims one, waits in line when none is free, and releases it. A claim is a lease: it ends when the holder releases, when the holder is no longer alive, or when the lease runs out unrenewed, and
// the next entry in line is granted. The order of the line is the entries' priority (a number the CALLER supplies, so this package knows nothing about tasks or goals), a slow gain of rank for the
// time spent waiting, and first come first served; a person's move of an entry (up, down, first) is an override that sticks.
//
// It has no dependency on the board, the server or the dashboard: the clock and the "is this agent alive" question are injected, the state can be saved and loaded through an optional Persister, and
// nothing here starts a goroutine. All of it is safe for concurrent use.
package resourcequeue

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Errors a caller can tell apart.
var (
	ErrNoResource  = errors.New("resourcequeue: no such resource")
	ErrNotAllowed  = errors.New("resourcequeue: this agent may not use this resource")
	ErrQueueFull   = errors.New("resourcequeue: this agent has too many entries waiting")
	ErrNotHolder   = errors.New("resourcequeue: this agent does not hold a slot of this resource")
	ErrNoEntry     = errors.New("resourcequeue: no such entry")
	ErrBadResource = errors.New("resourcequeue: a resource needs a name and at least one slot")
	ErrInPool      = errors.New("resourcequeue: the resource is a member of a pool: remove the pool first")
	ErrBadMatch    = errors.New("resourcequeue: a match is 1 to 8 words of letters, digits and . / _ : = @ % + , -, up to 200 characters, in all at most 20 of them")
)

// Resource is a thing with slots.
type Resource struct {
	Key      string        // the name: unique in one Queue ("mac-heavy"; a server-qualified id is the caller's business)
	Slots    int           // how many may hold it at once
	Machine  string        // where it is, for people to read; not interpreted
	MaxLease time.Duration // a claim is held this long unless renewed (0: DefaultLease)
	Allowed  []string      // agents that may claim it; empty: everyone
	Members  []string      // a pool (#13719): the resources whose slots this one hands out, in the order they are tried; a pool has no slots of its own, no Match and is claimed by hand until the shell hook knows machines
	Match    []string      // shell commands that claim it by themselves (the hook, #13645): each a list of words that must appear in order in one simple command, such as "go test ./..."; empty: no hook
}

// Claimant is who asks, and how much it matters.
type Claimant struct {
	Agent    string // who (a session or member id)
	Task     int    // what it is working on, for people to read (0: none)
	Project  string // the board that task is on (task numbers repeat across boards; #13704 links to it), "" when there is no task
	Priority int    // bigger goes first; supplied by the caller from the agent's task and goal
	Note     string // why, for people to read
	Via      string // how the claim came: "hook" for the shell hook's own, "" for a person's or an agent's (#13671)
	Pattern  string // for a hook claim, the resource's match pattern that fired (never the command)
}

// Entry is one agent's place in a resource's line, or its hold of a slot.
type Entry struct {
	ID       int64
	Resource string
	Claimant
	Enqueued time.Time
	Granted  time.Time // zero while waiting
	Lease    time.Time // when the hold ends unless renewed; zero while waiting
	Member   string    // on a pool's entry that holds a slot: the member (the machine) it was granted, "" otherwise (#13719)
	Pin      int       // a person's override: bigger is nearer the front among the waiting (set by Move)
	Away     time.Time // #13706: the agent's wait ended without a turn (its --timeout, its tool call) and its place is kept until this time; a claim from it again clears it. Zero: present
}

// Waiting reports whether the entry is still in line.
func (e Entry) Waiting() bool { return e.Granted.IsZero() }

// Result is what Claim answers.
type Result struct {
	Granted bool
	Place   int // 0 when granted; else the place in line, 1 is next
	Entry   Entry
}

// Status is one resource as it stands.
type Status struct {
	Resource Resource
	Now      time.Time
	Holders  []Entry // granted, oldest first
	Queue    []Entry // waiting, in the order they will be granted
}

// Config tunes a Queue; the zero value is usable.
type Config struct {
	Now         func() time.Time        // the clock (default time.Now)
	Alive       func(agent string) bool // false: the agent's session is gone, and its entries are dropped on the next Reap (default: everyone is alive)
	MaxPerAgent int                     // entries one agent may have waiting per resource (0: DefaultMaxPerAgent)
	AgeStep     time.Duration           // every AgeStep spent waiting is worth one point of priority (0: DefaultAgeStep; negative: no aging)
	AgeCap      int                     // aging adds at most this many points (0: DefaultAgeCap)
	OnGrant     func(Entry)             // called, outside the lock, for each entry that is granted by a release, a reap or a reorder (not for a claim answered at once: its Result says so)
	OnEvent     func(Event)             // called, outside the lock, for each change (#13671, the analytics' record): a panic in it is dropped, and it must not block (the Manager's history queues and returns)
	Persist     Persister               // optional: the state is saved after each change
}

// Event is one change in a queue, for the record of its use (#13671): who, which resource, how long it waited or held. It carries no command and no note.
type Event struct {
	At       time.Time
	Kind     string // enqueued, granted, released, cancelled (left the line), kicked (a person removed it), expired (the lease ran out), gone (the agent's session ended), renewed
	Resource string
	Agent    string
	Task     int
	Entry    int64
	Via      string
	Pattern  string
	Wait     time.Duration // granted: time in line; cancelled and kicked while waiting: time waited
	Held     time.Duration // released, kicked, expired and gone while holding: time held
}

// note records an event of e, to be told to the sink after the lock is let go.
func (q *Queue) note(kind string, e *Entry) {
	if q.cfg.OnEvent == nil {
		return
	}
	now := q.now()
	ev := Event{At: now, Kind: kind, Resource: e.Resource, Agent: e.Agent, Task: e.Task, Entry: e.ID, Via: e.Via, Pattern: e.Pattern}
	if e.Waiting() {
		ev.Wait = now.Sub(e.Enqueued)
	} else {
		ev.Held = now.Sub(e.Granted)
		if kind == "granted" {
			ev.Held, ev.Wait = 0, e.Granted.Sub(e.Enqueued)
		}
	}
	q.pend = append(q.pend, ev)
}

// unlockEmit lets the lock go and then tells the sink of what changed: outside the lock, and a sink that panics changes nothing.
func (q *Queue) unlockEmit() {
	evs := q.pend
	q.pend = nil
	q.mu.Unlock()
	if q.cfg.OnEvent == nil {
		return
	}
	for _, ev := range evs {
		func() {
			defer func() { _ = recover() }()
			q.cfg.OnEvent(ev)
		}()
	}
}

// Defaults.
const (
	DefaultLease       = 30 * time.Minute
	DefaultAwayGrace   = 10 * time.Minute // how long a place is kept for an agent whose wait ended without a turn (#13706)
	DefaultMaxPerAgent = 3
	DefaultAgeStep     = 3 * time.Minute // 10 points in about 30 minutes of waiting: one rank step of the board's task priorities (0, 10, 20, 30), so nothing starves behind a steady stream of the next class up
	DefaultAgeCap      = 10
)

// Persister keeps the state between runs.
type Persister interface {
	Save(State) error
	Load() (State, error)
}

// State is everything a Queue keeps: what a Persister saves.
type State struct {
	Resources []Resource
	Entries   []Entry
	NextID    int64
}

// Queue is the whole thing.
type Queue struct {
	mu      sync.Mutex
	cfg     Config
	res     map[string]*Resource
	entries []*Entry
	nextID  int64
	pend    []Event // events noted under the lock, told to the sink after it (OnEvent)
}

// New makes an empty Queue, or one loaded from cfg.Persist.
func New(cfg Config) (*Queue, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	q := &Queue{cfg: cfg, res: map[string]*Resource{}, nextID: 1}
	if cfg.Persist != nil {
		st, err := cfg.Persist.Load()
		if err != nil {
			return nil, fmt.Errorf("resourcequeue: loading the state: %w", err)
		}
		for i := range st.Resources {
			r := st.Resources[i]
			q.res[r.Key] = &r
		}
		for i := range st.Entries {
			e := st.Entries[i]
			q.entries = append(q.entries, &e)
		}
		if st.NextID > q.nextID {
			q.nextID = st.NextID
		}
	}
	return q, nil
}

func (q *Queue) now() time.Time { return q.cfg.Now() }
func (q *Queue) maxPer() int {
	if q.cfg.MaxPerAgent > 0 {
		return q.cfg.MaxPerAgent
	}
	return DefaultMaxPerAgent
}
func (q *Queue) ageStep() time.Duration {
	switch {
	case q.cfg.AgeStep < 0:
		return 0
	case q.cfg.AgeStep == 0:
		return DefaultAgeStep
	}
	return q.cfg.AgeStep
}
func (q *Queue) ageCap() int {
	if q.cfg.AgeCap > 0 {
		return q.cfg.AgeCap
	}
	return DefaultAgeCap
}
func (r *Resource) lease() time.Duration {
	if r.MaxLease > 0 {
		return r.MaxLease
	}
	return DefaultLease
}

// matchWord is one word of a match: no quote, no space, no control character, nothing a shell would read as more than a word.
var matchWord = regexp.MustCompile(`^[A-Za-z0-9._/:=@%+,-]{1,64}$`)

// ValidMatch checks a resource's match list: at most 20 matches, each 1 to 8 words, 200 characters at most.
func ValidMatch(match []string) error {
	if len(match) > 20 {
		return ErrBadMatch
	}
	for _, m := range match {
		words := strings.Fields(m)
		if len(m) > 200 || len(words) < 1 || len(words) > 8 || strings.Join(words, " ") != m {
			return ErrBadMatch
		}
		for _, w := range words {
			if !matchWord.MatchString(w) {
				return ErrBadMatch
			}
		}
	}
	return nil
}

// Define makes a resource, or changes the slots, machine, lease and allowed list of one that exists. More slots grant the waiting at once; fewer never take a slot from a holder (the holds run out).
func (q *Queue) Define(r Resource) error {
	pool := len(r.Members) > 0
	if r.Key == "" || (!pool && r.Slots < 1) || (pool && (r.Slots != 0 || len(r.Match) > 0)) {
		return ErrBadResource
	}
	if err := ValidMatch(r.Match); err != nil {
		return err
	}
	q.mu.Lock()
	if err := q.checkPoolLocked(r); err != nil {
		q.mu.Unlock()
		return err
	}
	cp := r
	cp.Members = append([]string(nil), r.Members...)
	cp.Allowed = append([]string(nil), r.Allowed...)
	cp.Match = append([]string(nil), r.Match...)
	q.res[r.Key] = &cp
	granted := q.fill(r.Key)
	err := q.save()
	q.mu.Unlock()
	q.notify(granted)
	return err
}

// MaxMembers is how many resources one pool may be made of.
const MaxMembers = 8

// checkPoolLocked refuses a pool that names itself, a pool, a resource that does not exist or one twice, and a resource that is a member of a pool becoming a pool (pools do not nest).
func (q *Queue) checkPoolLocked(r Resource) error {
	if len(r.Members) > 0 {
		if len(r.Members) > MaxMembers {
			return ErrBadResource
		}
		seen := map[string]bool{}
		for _, m := range r.Members {
			mr, ok := q.res[m]
			if !ok || m == r.Key || seen[m] || len(mr.Members) > 0 {
				return ErrBadResource
			}
			seen[m] = true
		}
		if len(q.poolsWith(r.Key)) > 0 {
			return ErrBadResource // it is a member of a pool: a member is not a pool
		}
	} else if old, ok := q.res[r.Key]; ok && len(old.Members) > 0 {
		return nil // a pool redefined as a plain resource: allowed, its entries go with the pool's slots (see Define)
	}
	return nil
}

// poolsWith are the pools that have key as a member.
func (q *Queue) poolsWith(key string) []string {
	var out []string
	for k, r := range q.res {
		for _, m := range r.Members {
			if m == key {
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Remove deletes a resource and every entry on it. A resource that is in a pool is not removed from under it.
func (q *Queue) Remove(key string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.res[key]; !ok {
		return ErrNoResource
	}
	if len(q.poolsWith(key)) > 0 {
		return ErrInPool
	}
	delete(q.res, key)
	kept := q.entries[:0]
	for _, e := range q.entries {
		if e.Resource != key {
			kept = append(kept, e)
		}
	}
	q.entries = kept
	return q.save()
}

// Claim asks for a slot. An agent that already has an entry on the resource gets that one back (a second ask is the same ask, and changes neither its place nor its priority, except that a higher
// priority is taken).
func (q *Queue) Claim(key string, who Claimant) (Result, error) {
	q.mu.Lock()
	r, ok := q.res[key]
	if !ok {
		q.unlockEmit()
		return Result{}, ErrNoResource
	}
	if !allowed(r, who.Agent) {
		q.unlockEmit()
		return Result{}, ErrNotAllowed
	}
	if e := q.entryFor(key, who.Agent); e != nil {
		if who.Priority > e.Priority {
			e.Priority = who.Priority
		}
		if !e.Away.IsZero() { // the agent is back (#13706): its place, still where it was, is its own again, and a free slot is its now
			e.Away = time.Time{}
			q.fill(e.Resource)
		}
		res := q.resultOf(e)
		err := q.save()
		q.unlockEmit()
		return res, err
	}
	waiting := 0 // across every resource: one agent cannot fill the lines
	for _, e := range q.entries {
		if e.Claimant.Agent == who.Agent && e.Waiting() {
			waiting++
		}
	}
	if waiting >= q.maxPer() {
		q.unlockEmit()
		return Result{}, ErrQueueFull
	}
	e := &Entry{ID: q.nextID, Resource: key, Claimant: who, Enqueued: q.now()}
	q.nextID++
	q.entries = append(q.entries, e)
	q.note("enqueued", e)
	q.fill(key)
	res := q.resultOf(e)
	err := q.save()
	q.unlockEmit()
	return res, err
}

// Renew extends the holder's lease to a full lease from now.
func (q *Queue) Renew(key, agent string) (Entry, error) {
	q.mu.Lock()
	defer q.unlockEmit()
	if _, ok := q.res[key]; !ok {
		return Entry{}, ErrNoResource
	}
	e := q.entryFor(key, agent)
	if e == nil || e.Waiting() {
		return Entry{}, ErrNotHolder
	}
	e.Lease = q.now().Add(q.leaseOf(e, q.res[e.Resource]))
	q.note("renewed", e)
	return *e, q.save()
}

// Release gives up a slot, or leaves the line; the next in line is granted.
func (q *Queue) Release(key, agent string) error {
	q.mu.Lock()
	if _, ok := q.res[key]; !ok {
		q.unlockEmit()
		return ErrNoResource
	}
	e := q.entryFor(key, agent)
	if e == nil {
		q.unlockEmit()
		return ErrNotHolder
	}
	if e.Waiting() {
		q.note("cancelled", e)
	} else {
		q.note("released", e)
	}
	at := e.Resource // the entry may have been found through a name that shares its slots
	q.drop(e.ID)
	granted := q.fill(at)
	err := q.save()
	q.unlockEmit()
	q.notify(granted)
	return err
}

// Leave is for an agent whose wait ended without a turn (its --timeout, the tool call it waited in): a place in line is kept for grace, the agent's own claim again takes it back at the same place, and
// when the grace ends (Reap) it goes. A slot that comes while the agent is away goes to the next one who is here, and the absent one keeps its place at the front for its return. A slot the agent already holds is given back, as Release does (#13706).
func (q *Queue) Leave(key, agent string, grace time.Duration) error {
	q.mu.Lock()
	if _, ok := q.res[key]; !ok {
		q.mu.Unlock()
		return ErrNoResource
	}
	e := q.entryFor(key, agent)
	if e == nil {
		q.mu.Unlock()
		return ErrNotHolder
	}
	if !e.Waiting() || grace <= 0 {
		at := e.Resource
		q.drop(e.ID)
		granted := q.fill(at)
		err := q.save()
		q.mu.Unlock()
		q.notify(granted)
		return err
	}
	e.Away = q.now().Add(grace)
	err := q.save()
	q.mu.Unlock()
	return err
}

// Reap ends the holds whose lease ran out and drops the entries of agents that are no longer alive, then grants the waiting. Call it from a timer; every other call also keeps the line honest.
func (q *Queue) Reap() (ended []Entry, err error) {
	q.mu.Lock()
	now := q.now()
	var keys = map[string]bool{}
	var kept []*Entry
	for _, e := range q.entries {
		dead := q.cfg.Alive != nil && !q.cfg.Alive(e.Claimant.Agent)
		expired := !e.Waiting() && !e.Lease.IsZero() && !now.Before(e.Lease)
		if e.Waiting() && !e.Away.IsZero() && !now.Before(e.Away) { // a place kept for an agent that did not come back (#13706)
			ended = append(ended, *e)
			keys[e.Resource] = true
			continue
		}
		if dead || expired {
			if dead {
				q.note("gone", e)
			} else {
				q.note("expired", e)
			}
			ended = append(ended, *e)
			keys[e.Resource] = true
			continue
		}
		kept = append(kept, e)
	}
	q.entries = kept
	var granted []Entry
	for k := range keys {
		granted = append(granted, q.fill(k)...)
	}
	err = q.save()
	q.unlockEmit()
	q.notify(granted)
	return ended, err
}

// Move is a person's override of the line: "up" and "down" by one place among the waiting, "first" to the front. After a move the line stands as the person set it (every waiting entry is pinned in that
// order); an entry that arrives later joins behind them, by its rank, and the pins go when the line is empty.
func (q *Queue) Move(id int64, how string) error {
	q.mu.Lock()
	e := q.byID(id)
	if e == nil || !e.Waiting() {
		q.unlockEmit()
		return ErrNoEntry
	}
	line := q.line(e.Resource)
	at := -1
	for i, x := range line {
		if x.ID == id {
			at = i
		}
	}
	to := at
	switch how {
	case "first":
		to = 0
	case "up":
		to = max(at-1, 0)
	case "down":
		to = min(at+1, len(line)-1)
	default:
		q.unlockEmit()
		return fmt.Errorf("resourcequeue: move %q: up, down or first", how)
	}
	line = append(line[:at], line[at+1:]...)
	line = append(line[:to], append([]*Entry{e}, line[to:]...)...)
	for i, x := range line {
		x.Pin = len(line) - i
	}
	granted := q.fill(e.Resource)
	err := q.save()
	q.unlockEmit()
	q.notify(granted)
	return err
}

// Cancel removes one entry (waiting or holding), whoever it belongs to: the Orchestrator's kick.
func (q *Queue) Cancel(id int64) error {
	q.mu.Lock()
	e := q.byID(id)
	if e == nil {
		q.unlockEmit()
		return ErrNoEntry
	}
	key := e.Resource
	q.note("kicked", e)
	q.drop(id)
	granted := q.fill(key)
	err := q.save()
	q.unlockEmit()
	q.notify(granted)
	return err
}

// AnyMatch reports whether any resource has a match list (the shell hook has work only then).
func (q *Queue) AnyMatch() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, r := range q.res {
		if len(r.Match) > 0 {
			return true
		}
	}
	return false
}

// Status describes one resource.
func (q *Queue) Status(key string) (Status, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	r, ok := q.res[key]
	if !ok {
		return Status{}, ErrNoResource
	}
	return q.status(r), nil
}

// All describes every resource, by name.
func (q *Queue) All() []Status {
	q.mu.Lock()
	defer q.mu.Unlock()
	keys := make([]string, 0, len(q.res))
	for k := range q.res {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]Status, 0, len(keys))
	for _, k := range keys {
		out = append(out, q.status(q.res[k]))
	}
	return out
}

// Snapshot is the whole state, for a Persister or a test.
func (q *Queue) Snapshot() State {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.state()
}

// ---- inside (the lock is held) ----

func allowed(r *Resource, agent string) bool {
	if len(r.Allowed) == 0 {
		return true
	}
	for _, a := range r.Allowed {
		if a == agent {
			return true
		}
	}
	return false
}

func (q *Queue) byID(id int64) *Entry {
	for _, e := range q.entries {
		if e.ID == id {
			return e
		}
	}
	return nil
}

func (q *Queue) entryOf(key, agent string) *Entry {
	for _, e := range q.entries {
		if e.Resource == key && e.Claimant.Agent == agent {
			return e
		}
	}
	return nil
}

// related are the resources that share slots with key: for a pool, itself and its members; for a member, each pool it is in and those pools' members, and itself.
func (q *Queue) related(key string) map[string]bool {
	out := map[string]bool{key: true}
	add := func(pool string) {
		out[pool] = true
		if r := q.res[pool]; r != nil {
			for _, m := range r.Members {
				out[m] = true
			}
		}
	}
	if r := q.res[key]; r != nil && len(r.Members) > 0 {
		add(key)
	}
	for _, p := range q.poolsWith(key) {
		add(p)
	}
	return out
}

// entryFor is the agent's entry on key, or on anything that shares slots with it: an agent holds at most one slot across a pool and its members (a chained run is one command: it never needs two), so a second claim joins the first.
func (q *Queue) entryFor(key, agent string) *Entry {
	if e := q.entryOf(key, agent); e != nil {
		return e
	}
	rel := q.related(key)
	for _, e := range q.entries {
		if e.Claimant.Agent == agent && rel[e.Resource] {
			return e
		}
	}
	return nil
}

func (q *Queue) drop(id int64) {
	kept := q.entries[:0]
	for _, e := range q.entries {
		if e.ID != id {
			kept = append(kept, e)
		}
	}
	q.entries = kept
}

// bonus is the rank a waiting entry has gained by waiting.
func (q *Queue) bonus(e *Entry) int {
	step := q.ageStep()
	if step <= 0 {
		return 0
	}
	n := int(q.now().Sub(e.Enqueued) / step)
	return min(max(n, 0), q.ageCap())
}

func (q *Queue) rank(e *Entry) int { return e.Priority + q.bonus(e) }

// line is a resource's waiting entries in the order they will be granted: a person's pin first, then priority with its aging, then first come first served.
func (q *Queue) line(key string) []*Entry {
	var w []*Entry
	for _, e := range q.entries {
		if e.Resource == key && e.Waiting() {
			w = append(w, e)
		}
	}
	sort.SliceStable(w, func(i, j int) bool { return q.before(w[i], w[j]) })
	return w
}

// held is how many slots of key are in use: the holds on it, and the holds of its pools that were granted this member.
func (q *Queue) held(key string) int {
	n := 0
	for _, e := range q.entries {
		if !e.Waiting() && (e.Resource == key || e.Member == key) {
			n++
		}
	}
	return n
}

// leaseOf is how long a hold lasts: the member's lease for a pool's entry (the machine it runs on), else the resource's own.
func (q *Queue) leaseOf(e *Entry, r *Resource) time.Duration {
	if e.Member != "" {
		if m := q.res[e.Member]; m != nil {
			return m.lease()
		}
	}
	return r.lease()
}

// before is the order of the waiting: a person's pin, then rank (priority and age), then who came first.
func (q *Queue) before(a, b *Entry) bool {
	if a.Pin != b.Pin {
		return a.Pin > b.Pin
	}
	if ra, rb := q.rank(a), q.rank(b); ra != rb {
		return ra > rb
	}
	if !a.Enqueued.Equal(b.Enqueued) {
		return a.Enqueued.Before(b.Enqueued)
	}
	return a.ID < b.ID
}

// bestWaiter is who gets a free slot of member m: the best of ALL the lines that share it, the member's own and those of the pools it is in, by one ranking (priority, then age), whatever freed the slot. An agent that is away is skipped.
func (q *Queue) bestWaiter(m string) *Entry {
	var best *Entry
	for _, key := range append([]string{m}, q.poolsWith(m)...) {
		for _, x := range q.line(key) {
			if !x.Away.IsZero() { // an agent that is away is skipped (#13706): the slot goes to the next one who is here, and the absent one keeps its place at the front
				continue
			}
			if best == nil || q.before(x, best) {
				best = x
			}
			break // line() is in order: its first one here is its best
		}
	}
	return best
}

// fill grants free slots to the waiting. Slots are the members' (a plain resource is its own member): for key, or for the members of key when it is a pool, a free slot goes to bestWaiter. It returns the entries it granted.
func (q *Queue) fill(key string) []Entry {
	r, ok := q.res[key]
	if !ok {
		return nil
	}
	members := []string{key}
	if len(r.Members) > 0 {
		members = r.Members
	}
	var granted []Entry
	for progress := true; progress; {
		progress = false
		for _, m := range members {
			mr := q.res[m]
			if mr == nil || len(mr.Members) > 0 || q.held(m) >= mr.Slots {
				continue
			}
			e := q.bestWaiter(m)
			if e == nil {
				continue
			}
			e.Granted = q.now()
			if e.Resource != m { // a pool's entry: it holds this member
				e.Member = m
			}
			e.Lease = e.Granted.Add(q.leaseOf(e, q.res[e.Resource]))
			granted = append(granted, *e)
			q.note("granted", e)
			progress = true
		}
	}
	return granted
}

func (q *Queue) resultOf(e *Entry) Result {
	if !e.Waiting() {
		return Result{Granted: true, Entry: *e}
	}
	for i, x := range q.line(e.Resource) {
		if x == e {
			return Result{Place: i + 1, Entry: *e}
		}
	}
	return Result{Entry: *e}
}

func (q *Queue) status(r *Resource) Status {
	st := Status{Resource: *r, Now: q.now()}
	if len(r.Members) > 0 { // a pool reads as the sum of its members' slots
		for _, m := range r.Members {
			if mr := q.res[m]; mr != nil {
				st.Resource.Slots += mr.Slots
			}
		}
	}
	for _, e := range q.entries {
		if !e.Waiting() && (e.Resource == r.Key || e.Member == r.Key) { // a member's holders include the pool's holds on it
			st.Holders = append(st.Holders, *e)
		}
	}
	sort.Slice(st.Holders, func(i, j int) bool { return st.Holders[i].Granted.Before(st.Holders[j].Granted) })
	for _, e := range q.line(r.Key) {
		st.Queue = append(st.Queue, *e)
	}
	return st
}

func (q *Queue) state() State {
	st := State{NextID: q.nextID}
	keys := make([]string, 0, len(q.res))
	for k := range q.res {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		st.Resources = append(st.Resources, *q.res[k])
	}
	for _, e := range q.entries {
		st.Entries = append(st.Entries, *e)
	}
	return st
}

func (q *Queue) save() error {
	if q.cfg.Persist == nil {
		return nil
	}
	return q.cfg.Persist.Save(q.state())
}

func (q *Queue) notify(granted []Entry) {
	if q.cfg.OnGrant == nil {
		return
	}
	for _, e := range granted {
		q.cfg.OnGrant(e)
	}
}
