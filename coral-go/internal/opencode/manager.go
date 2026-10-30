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

	mu      sync.Mutex
	servers map[string]*managed
	closed  bool
}

// managed is one agent's server and the loop reading its events.
type managed struct {
	srv    *Server
	cancel context.CancelFunc
	done   chan struct{} // closed when the event loop has returned

	mu      sync.Mutex
	tracker *Tracker
	at      map[string]time.Time // when each session last changed state
}

func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, servers: map[string]*managed{}}
}

// Ensure returns the agent's server, starting it (and the reading of its events) on the first call; a server that has since exited is started again.
func (m *Manager) Ensure(ctx context.Context, key string) (*Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errManagerClosed
	}
	if g := m.servers[key]; g != nil {
		select {
		case <-g.srv.done:
			g.stop()
			delete(m.servers, key)
		default:
			return g.srv, nil
		}
	}
	srv, err := Start(ctx, m.cfg, key)
	if err != nil {
		return nil, err
	}
	g := &managed{srv: srv, done: make(chan struct{}), tracker: NewTracker(), at: map[string]time.Time{}}
	var lctx context.Context
	lctx, g.cancel = context.WithCancel(context.Background()) // not ctx: the loop lives as long as the server
	go g.loop(lctx)
	m.servers[key] = g
	return srv, nil
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

// Close stops every server and loop, and refuses any later Ensure.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	all := m.servers
	m.servers = map[string]*managed{}
	m.mu.Unlock()
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
