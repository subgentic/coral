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
	"sort"
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
)

// Resource is a thing with slots.
type Resource struct {
	Key      string        // the name: unique in one Queue ("mac-heavy"; a server-qualified id is the caller's business)
	Slots    int           // how many may hold it at once
	Machine  string        // where it is, for people to read; not interpreted
	MaxLease time.Duration // a claim is held this long unless renewed (0: DefaultLease)
	Allowed  []string      // agents that may claim it; empty: everyone
}

// Claimant is who asks, and how much it matters.
type Claimant struct {
	Agent    string // who (a session or member id)
	Task     int    // what it is working on, for people to read (0: none)
	Priority int    // bigger goes first; supplied by the caller from the agent's task and goal
	Note     string // why, for people to read
}

// Entry is one agent's place in a resource's line, or its hold of a slot.
type Entry struct {
	ID       int64
	Resource string
	Claimant
	Enqueued time.Time
	Granted  time.Time // zero while waiting
	Lease    time.Time // when the hold ends unless renewed; zero while waiting
	Pin      int       // a person's override: bigger is nearer the front among the waiting (set by Move)
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
	Persist     Persister               // optional: the state is saved after each change
}

// Defaults.
const (
	DefaultLease       = 30 * time.Minute
	DefaultMaxPerAgent = 3
	DefaultAgeStep     = 10 * time.Minute
	DefaultAgeCap      = 5
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

// Define makes a resource, or changes the slots, machine, lease and allowed list of one that exists. More slots grant the waiting at once; fewer never take a slot from a holder (the holds run out).
func (q *Queue) Define(r Resource) error {
	if r.Key == "" || r.Slots < 1 {
		return ErrBadResource
	}
	q.mu.Lock()
	cp := r
	cp.Allowed = append([]string(nil), r.Allowed...)
	q.res[r.Key] = &cp
	granted := q.fill(r.Key)
	err := q.save()
	q.mu.Unlock()
	q.notify(granted)
	return err
}

// Remove deletes a resource and every entry on it.
func (q *Queue) Remove(key string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.res[key]; !ok {
		return ErrNoResource
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
		q.mu.Unlock()
		return Result{}, ErrNoResource
	}
	if !allowed(r, who.Agent) {
		q.mu.Unlock()
		return Result{}, ErrNotAllowed
	}
	if e := q.entryOf(key, who.Agent); e != nil {
		if who.Priority > e.Priority {
			e.Priority = who.Priority
		}
		res := q.resultOf(e)
		err := q.save()
		q.mu.Unlock()
		return res, err
	}
	waiting := 0 // across every resource: one agent cannot fill the lines
	for _, e := range q.entries {
		if e.Claimant.Agent == who.Agent && e.Waiting() {
			waiting++
		}
	}
	if waiting >= q.maxPer() {
		q.mu.Unlock()
		return Result{}, ErrQueueFull
	}
	e := &Entry{ID: q.nextID, Resource: key, Claimant: who, Enqueued: q.now()}
	q.nextID++
	q.entries = append(q.entries, e)
	q.fill(key)
	res := q.resultOf(e)
	err := q.save()
	q.mu.Unlock()
	return res, err
}

// Renew extends the holder's lease to a full lease from now.
func (q *Queue) Renew(key, agent string) (Entry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	r, ok := q.res[key]
	if !ok {
		return Entry{}, ErrNoResource
	}
	e := q.entryOf(key, agent)
	if e == nil || e.Waiting() {
		return Entry{}, ErrNotHolder
	}
	e.Lease = q.now().Add(r.lease())
	return *e, q.save()
}

// Release gives up a slot, or leaves the line; the next in line is granted.
func (q *Queue) Release(key, agent string) error {
	q.mu.Lock()
	if _, ok := q.res[key]; !ok {
		q.mu.Unlock()
		return ErrNoResource
	}
	e := q.entryOf(key, agent)
	if e == nil {
		q.mu.Unlock()
		return ErrNotHolder
	}
	q.drop(e.ID)
	granted := q.fill(key)
	err := q.save()
	q.mu.Unlock()
	q.notify(granted)
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
		if dead || expired {
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
	q.mu.Unlock()
	q.notify(granted)
	return ended, err
}

// Move is a person's override of the line: "up" and "down" by one place among the waiting, "first" to the front. After a move the line stands as the person set it (every waiting entry is pinned in that
// order); an entry that arrives later joins behind them, by its rank, and the pins go when the line is empty.
func (q *Queue) Move(id int64, how string) error {
	q.mu.Lock()
	e := q.byID(id)
	if e == nil || !e.Waiting() {
		q.mu.Unlock()
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
		q.mu.Unlock()
		return fmt.Errorf("resourcequeue: move %q: up, down or first", how)
	}
	line = append(line[:at], line[at+1:]...)
	line = append(line[:to], append([]*Entry{e}, line[to:]...)...)
	for i, x := range line {
		x.Pin = len(line) - i
	}
	granted := q.fill(e.Resource)
	err := q.save()
	q.mu.Unlock()
	q.notify(granted)
	return err
}

// Cancel removes one entry (waiting or holding), whoever it belongs to: the Orchestrator's kick.
func (q *Queue) Cancel(id int64) error {
	q.mu.Lock()
	e := q.byID(id)
	if e == nil {
		q.mu.Unlock()
		return ErrNoEntry
	}
	key := e.Resource
	q.drop(id)
	granted := q.fill(key)
	err := q.save()
	q.mu.Unlock()
	q.notify(granted)
	return err
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
	sort.SliceStable(w, func(i, j int) bool {
		a, b := w[i], w[j]
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
	})
	return w
}

func (q *Queue) held(key string) int {
	n := 0
	for _, e := range q.entries {
		if e.Resource == key && !e.Waiting() {
			n++
		}
	}
	return n
}

// fill grants the waiting, in line order, while slots are free. It returns the entries it granted.
func (q *Queue) fill(key string) []Entry {
	r, ok := q.res[key]
	if !ok {
		return nil
	}
	var granted []Entry
	for q.held(key) < r.Slots {
		line := q.line(key)
		if len(line) == 0 {
			break
		}
		e := line[0]
		e.Granted = q.now()
		e.Lease = e.Granted.Add(r.lease())
		granted = append(granted, *e)
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
	for _, e := range q.entries {
		if e.Resource == r.Key && !e.Waiting() {
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
