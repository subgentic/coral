package resources

import (
	"fmt"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// The kinds of Signal: an agent stopped at a dialog or permission prompt, or one whose turn is over with nothing running. "" is working, or not known.
const (
	SignalPrompt = "prompt"
	SignalIdle   = "idle"
)

// Default times (#13705): the Orchestrator is told when a holder has sat at a prompt (or idle) this long, and told again, with the way to kick it, at the second.
const (
	StuckFirst  = 5 * time.Minute
	StuckSecond = 10 * time.Minute
)

// WatchOptions says how the Watcher sees an agent and who it tells.
type WatchOptions struct {
	// Signal is what Coral knows of the agent: its kind (SignalPrompt, SignalIdle or "") and since when it has been in that state. "" or a zero time: working, or not known, so nothing is done.
	Signal func(agent string) (kind string, since time.Time)
	// Notify tells the Orchestrator of the agent's team (a board post). Called outside every lock; nil: nothing is told.
	Notify        func(agent, text string)
	Now           func() time.Time
	First, Second time.Duration // 0: StuckFirst, StuckSecond
}

// StuckInfo is what the Queue shows of a holder that is stuck.
type StuckInfo struct {
	Kind  string        // SignalPrompt or SignalIdle
	Since time.Time     // when the stuck time is counted from: the later of its state's start and its being granted the slot
	Level int           // 1: told at the first time, 2: told again at the second
	Age   time.Duration // how long, by the watcher's clock
}

type watchState struct {
	kind  string
	since time.Time
	level int
}

// Watcher keeps an eye on the agents that hold a slot (#13705): a holder at a prompt waiting for a person, or idle, keeps others waiting for nothing. It never takes the slot: it tells the Orchestrator (who kicks) and
// marks the row, because a command waiting for its approval would run beside the next holder's if the slot were handed on. Fail open: an agent Coral cannot read is left alone.
type Watcher struct {
	m  *Manager
	o  WatchOptions
	mu sync.Mutex
	st map[int64]*watchState
}

// NewWatcher makes the Watcher of a Manager's holders.
func NewWatcher(m *Manager, o WatchOptions) *Watcher {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.First <= 0 {
		o.First = StuckFirst
	}
	if o.Second <= 0 {
		o.Second = StuckSecond
	}
	return &Watcher{m: m, o: o, st: map[int64]*watchState{}}
}

// Check looks at every holder once: call it every few seconds.
func (w *Watcher) Check() {
	if w == nil || w.o.Signal == nil {
		return
	}
	now := w.o.Now()
	type notice struct{ agent, text string }
	var said []notice
	live := map[int64]bool{}
	var statuses = w.m.Queue().All()
	w.mu.Lock()
	for _, s := range statuses {
		for _, e := range s.Holders {
			if e.Agent == "Operator" {
				continue
			}
			live[e.ID] = true
			kind, since := w.o.Signal(e.Agent)
			if kind == "" || since.IsZero() {
				delete(w.st, e.ID) // working again, or not known: no episode
				continue
			}
			if e.Granted.After(since) {
				since = e.Granted // idle or at a prompt before it held the slot does not count against it
			}
			cur := w.st[e.ID]
			if cur == nil || cur.kind != kind || !cur.since.Equal(since) {
				cur = &watchState{kind: kind, since: since}
				w.st[e.ID] = cur
			}
			age := now.Sub(since)
			switch {
			case age >= w.o.Second && cur.level < 2:
				cur.level = 2
				said = append(said, notice{e.Agent, w.words(e, s, kind, age, true)})
			case age >= w.o.First && cur.level < 1:
				cur.level = 1
				said = append(said, notice{e.Agent, w.words(e, s, kind, age, false)})
			}
		}
	}
	for id := range w.st {
		if !live[id] {
			delete(w.st, id) // it released, was kicked or expired
		}
	}
	w.mu.Unlock()
	if w.o.Notify != nil {
		for _, n := range said {
			w.o.Notify(n.agent, n.text)
		}
	}
}

func (w *Watcher) words(e resourcequeue.Entry, s resourcequeue.Status, kind string, age time.Duration, second bool) string {
	what := "is at a prompt waiting for a person"
	if kind == SignalIdle {
		what = "is idle with nothing running"
	}
	line := fmt.Sprintf("%s holder %s %s, %d min, %d waiting.", s.Resource.Key, e.Agent, what, int(age/time.Minute), len(s.Queue))
	if second {
		line += fmt.Sprintf(" Still stuck: kick it with coral-board resource kick %d if its prompt is not coming (the Queue folder says Stuck).", e.ID)
	}
	return line
}

// Stuck says whether the holder entry is stuck now, for the Queue's row.
func (w *Watcher) Stuck(entryID int64) (StuckInfo, bool) {
	if w == nil {
		return StuckInfo{}, false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	cur := w.st[entryID]
	if cur == nil || cur.level == 0 {
		return StuckInfo{}, false
	}
	return StuckInfo{Kind: cur.kind, Since: cur.since, Level: cur.level, Age: w.o.Now().Sub(cur.since)}, true
}
