package opencode

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Manager runs one opencode server per agent (Start, keyed by the agent's name) and reads each one's event stream into the state of its sessions: the working/idle dot and "your turn" of an opencode agent
// come from here, with no hook (#11364). Everything it starts is stopped by Stop or Close: a server by its own pid, a stream by its context.
type Manager struct {
	cfg Config

	mu       sync.Mutex
	servers  map[string]*managed
	starting map[string]*starting // servers being started, by key
	closed   bool
	reapStop chan struct{} // closed by Close: the reaper ends
	reapDone chan struct{}
}

// starting is a server on its way up: done closes when it is published in servers or has failed.
type starting struct{ done chan struct{} }

// managed is one agent's server and the loop reading its events.
type managed struct {
	srv    *Server
	cancel context.CancelFunc
	done   chan struct{} // closed when the event loop has returned
	since  time.Time     // when the server came up

	mu      sync.Mutex
	tracker *Tracker
	at      map[string]time.Time // when each session last changed state
}

func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, servers: map[string]*managed{}, starting: map[string]*starting{}}
}

// Ensure returns the agent's server, starting it (and the reading of its events) on the first call; a server that has since exited is started again. bin is the opencode binary the person's settings
// name, "opencode" (found on the PATH) when it is empty and the manager has none of its own.
//
// The manager's lock is held only around its maps, never across a start (which can take a minute): a slow start of one agent's server never holds up AgentTurn, Stop or another agent's launch. A second
// Ensure for a key that is starting waits for that start and shares its result.
func (m *Manager) Ensure(ctx context.Context, key, bin string) (*Server, error) {
	for {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return nil, errManagerClosed
		}
		var dead *managed
		if g := m.servers[key]; g != nil {
			select {
			case <-g.srv.done:
				dead = g
				delete(m.servers, key)
			default:
				m.mu.Unlock()
				return g.srv, nil
			}
		}
		if st := m.starting[key]; st != nil {
			m.mu.Unlock()
			select {
			case <-st.done:
				continue // it has published its server, or failed: look again
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		st := &starting{done: make(chan struct{})}
		m.starting[key] = st
		m.mu.Unlock()

		if dead != nil {
			dead.stop()
		}
		g, err := m.start(ctx, key, bin)

		m.mu.Lock()
		delete(m.starting, key)
		if err == nil && m.closed {
			err = errManagerClosed
		} else if err == nil {
			m.servers[key] = g
		}
		m.mu.Unlock()
		close(st.done)
		if err != nil {
			if g != nil {
				g.stop()
			}
			return nil, err
		}
		return g.srv, nil
	}
}

// start runs one server and the loop reading its events; it touches none of the manager's maps.
func (m *Manager) start(ctx context.Context, key, bin string) (*managed, error) {
	cfg := m.cfg
	if bin != "" {
		cfg.Bin = bin
	} else if cfg.Bin == "" {
		cfg.Bin = "opencode"
	}
	srv, err := Start(ctx, cfg, key)
	if err != nil {
		return nil, err
	}
	g := &managed{srv: srv, since: time.Now(), done: make(chan struct{}), tracker: NewTracker(), at: map[string]time.Time{}}
	var lctx context.Context
	lctx, g.cancel = context.WithCancel(context.Background()) // not ctx: the loop lives as long as the server
	go g.loop(lctx)
	return g, nil
}

// Turn is the state the event stream last put session in, and when; ok is false when no stream has named it (or a gap in a stream made it unknown).
func (m *Manager) Turn(session string) (state State, at time.Time, ok bool) {
	m.mu.Lock()
	all := make([]*managed, 0, len(m.servers))
	for _, g := range m.servers {
		all = append(all, g)
	}
	m.mu.Unlock()
	for _, g := range all {
		g.mu.Lock()
		s, t := g.tracker.State(session), g.at[session]
		g.mu.Unlock()
		if s != "" {
			return s, t, true
		}
	}
	return "", time.Time{}, false
}

// AgentTurn is the state of the agent's newest session on its own server: Coral's id for an opencode agent is not opencode's ses_ id, and the agent has one server, so what its server last said is the agent's.
// ok is false when the agent has no server or its stream has named no session (or a gap made them unknown).
func (m *Manager) AgentTurn(key string) (state State, at time.Time, ok bool) {
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil {
		return "", time.Time{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for session, t := range g.at {
		if s := g.tracker.State(session); s != "" && (!ok || t.After(at)) {
			state, at, ok = s, t, true
		}
	}
	return state, at, ok
}

// Stop ends one agent's server and the loop reading it.
func (m *Manager) Stop(key string) {
	m.mu.Lock()
	g := m.servers[key]
	delete(m.servers, key)
	m.mu.Unlock()
	if g != nil {
		g.stop()
	}
}

// Reap stops every server that has been up for at least minAge and whose agent is no longer alive (alive false): an agent that ended, slept or was deleted by a path that never told the manager keeps no
// opencode process. It returns the keys it stopped. A young server is left alone, so one whose agent row is not written yet is never reaped.
func (m *Manager) Reap(alive func(key string) bool, minAge time.Duration) []string {
	m.mu.Lock()
	var stale []string
	for key, g := range m.servers {
		if time.Since(g.since) >= minAge {
			stale = append(stale, key)
		}
	}
	m.mu.Unlock()
	var stopped []string
	for _, key := range stale {
		if alive(key) {
			continue
		}
		m.mu.Lock()
		g := m.servers[key]
		if g != nil && time.Since(g.since) >= minAge { // still the server that was judged
			delete(m.servers, key)
		} else {
			g = nil
		}
		m.mu.Unlock()
		if g != nil {
			g.stop()
			stopped = append(stopped, key)
		}
	}
	return stopped
}

// StartReaper runs Reap every interval until Close. Once only: a second call does nothing.
func (m *Manager) StartReaper(interval, minAge time.Duration, alive func(key string) bool) {
	m.mu.Lock()
	if m.closed || m.reapStop != nil {
		m.mu.Unlock()
		return
	}
	m.reapStop, m.reapDone = make(chan struct{}), make(chan struct{})
	stop, done := m.reapStop, m.reapDone
	m.mu.Unlock()
	go func() {
		defer close(done)
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				m.Reap(alive, minAge)
			}
		}
	}()
}

// Close stops every server and loop, and refuses any later Ensure.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	stop, done := m.reapStop, m.reapDone
	m.reapStop = nil
	if stop != nil {
		close(stop)
	}
	all := m.servers
	m.servers = map[string]*managed{}
	m.mu.Unlock()
	if done != nil {
		<-done
	}
	for _, g := range all {
		g.stop()
	}
}

func (g *managed) stop() {
	g.cancel()
	<-g.done
	g.srv.Stop()
}

// loop reads the event stream until ctx ends. When the stream drops, what it said may be stale: every state is forgotten (Reset) and the stream is read again after a growing pause.
func (g *managed) loop(ctx context.Context) {
	defer close(g.done)
	c, err := g.srv.Client()
	if err != nil {
		return
	}
	pause := 500 * time.Millisecond
	for ctx.Err() == nil {
		began := time.Now()
		_ = c.Events(ctx, func(e Event) {
			g.mu.Lock()
			defer g.mu.Unlock()
			if session, _, moved := g.tracker.Apply(e); moved {
				g.at[session] = time.Now()
			}
		})
		g.mu.Lock()
		g.tracker.Reset()
		g.at = map[string]time.Time{}
		g.mu.Unlock()
		if time.Since(began) > 30*time.Second {
			pause = 500 * time.Millisecond // it was up a while: a fresh start of the backoff
		}
		select {
		case <-ctx.Done():
			return
		case <-g.srv.done:
			return
		case <-time.After(pause):
		}
		if pause < 15*time.Second {
			pause *= 2
		}
	}
}

var errManagerClosed = errors.New("opencode: the server manager is closed")
