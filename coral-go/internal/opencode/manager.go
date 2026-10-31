package opencode

import (
	"context"
	"errors"
	"github.com/subgentic/coral/internal/safego"
	"sync"
	"time"
)

// Manager runs one opencode server per agent (Start, keyed by the agent's name) and reads each one's event stream into the state of its sessions: the working/idle dot and "your turn" of an opencode agent
// come from here, with no hook (#11364). Everything it starts is stopped by Stop or Close: a server by its own pid, a stream by its context.
type Manager struct {
	cfg Config

	mu              sync.Mutex
	servers         map[string]*managed
	starting        map[string]*starting  // servers being started, by key
	stores          map[string]string     // the store each live or starting server runs on, by key
	alive           func(key string) bool // the reaper's question (StartReaper): whether an agent is awake; nil until it is set
	readFail        map[string]time.Time  // when a start of a reader for the key last failed
	readerStarting  map[string]bool       // readers admitted whose start is under way (they count against the cap before they run)
	readerStartAt   map[string]time.Time  // when a reader for the key was last admitted
	lastReaderStart time.Time             // when any reader was last admitted
	closed          bool
	reapStop        chan struct{} // closed by Close: the reaper ends
	reapDone        chan struct{}

	// Redact redacts a text before the newest message is kept on disk; false means it could not be checked, and then nothing is kept. Set before the first Ensure; nil keeps the text as it is.
	Redact func(text string) (string, bool)

	// SkipLast says a message is not one the list shows as the last (what Coral typed into the agent); nil skips none. Set before the first Ensure.
	SkipLast func(Message) bool

	beforeStop func() // a test's hook: runs while a key is reserved for its server's stop
}

// starting is a server on its way up: done closes when it is published in servers or has failed.
type starting struct{ done chan struct{} }

// managed is one agent's server and the loop reading its events.
type managed struct {
	srv      *Server
	cancel   context.CancelFunc
	done     chan struct{} // closed when the event loop has returned
	since    time.Time     // when the server came up
	key      string        // the agent this server is for
	idle     *time.Timer   // a reader stops itself when this fires (under mu); nil for a server that is not one
	lastRead time.Time     // when the history was last read through this reader (under mu)
	reader   bool          // started only to read the agent's history (ReadHistory); set before it is published
	store    string        // the key of the agent whose session store this server runs on (its own, or the one a resumed session is in)
	dataDir  string
	noted    map[string]bool // sessions whose store has been recorded (under mu)
	lctx     context.Context // the event loop's: what ends with the server

	mu      sync.Mutex
	tracker *Tracker
	at      map[string]time.Time // when each session last changed state

	sawState   bool      // the stream has put some session in a state at least once (under mu)
	session    string    // the opencode session the agent was resumed with: known before the stream names any
	sessionAt  time.Time // when UseSession was told
	version    int       // counts the events of the agent's sessions: what a cached read of the history was made at
	msgs       []Message
	msgsAt     int        // the version msgs was read at; -1 when never
	msgsReadAt time.Time  // when the history was last read
	reads      int        // how many times it was read (a test counts them)
	msgsMu     sync.Mutex // one read of the history at a time
	last       Message    // the newest message of the agent's newest session, as read when a turn last ended
	haveLast   bool
	refreshing bool // a read of it is under way: one at a time
}

func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, servers: map[string]*managed{}, starting: map[string]*starting{}, stores: map[string]string{}, readFail: map[string]time.Time{}, readerStarting: map[string]bool{}, readerStartAt: map[string]time.Time{}}
}

// Ensure returns the agent's server, starting it (and the reading of its events) on the first call; a server that has since exited is started again. bin is the opencode binary the person's settings
// name, "opencode" (found on the PATH) when it is empty and the manager has none of its own; model is the model the agent's server starts on ("": opencode's own default).
//
// The manager's lock is held only around its maps, never across a start (which can take a minute): a slow start of one agent's server never holds up AgentTurn, Stop or another agent's launch. A second
// Ensure for a key that is starting waits for that start and shares its result.
func (m *Manager) Ensure(ctx context.Context, key, bin, model, resume string) (*Server, error) {
	return m.ensure(ctx, key, bin, model, resume, false)
}

// ensure is Ensure; reader says the server is started only to READ an agent's history (ReadHistory), not for the agent to run on: a launch that finds such a server replaces it (it was started without the agent's
// model), and the reaper and the cap treat it as the lightest kind.
func (m *Manager) ensure(ctx context.Context, key, bin, model, resume string, reader bool) (*Server, error) {
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
				if !g.reader || reader { // a launch does not run on a server that was started only to read
					m.mu.Unlock()
					return g.srv, nil
				}
				dead = g
				delete(m.servers, key)
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
		store := m.pickStore(key, resume)
		m.stores[key] = store
		m.mu.Unlock()

		if dead != nil {
			dead.stop()
		}
		g, err := m.start(ctx, key, bin, model, store)
		if g != nil {
			g.reader = reader
		}

		m.mu.Lock()
		delete(m.starting, key)
		if err == nil && m.closed {
			err = errManagerClosed
		} else if err == nil {
			m.servers[key] = g
		}
		if err != nil {
			delete(m.stores, key)
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

// pickStore is the agent whose session store a server for key runs on: its own, or, for a resumed session, the store that session was made in (the agent had another Coral id then) when no other live server
// holds it. A session whose store is not known, or is held, is simply not found by the new server: never shared. The caller holds m.mu.
func (m *Manager) pickStore(key, resume string) string {
	if from := storeOf(m.cfg.DataDir, resume); from != "" && from != key {
		for k, held := range m.stores {
			if held == from && k != key {
				return key
			}
		}
		return from
	}
	return key
}

// start runs one server and the loop reading its events; it touches none of the manager's maps.
func (m *Manager) start(ctx context.Context, key, bin, model, store string) (*managed, error) {
	cfg := m.cfg
	cfg.Model = model
	cfg.DBFile = StoreFile(cfg.DataDir, store)
	if bin != "" {
		cfg.Bin = bin
	} else if cfg.Bin == "" {
		cfg.Bin = "opencode"
	}
	srv, err := Start(ctx, cfg, key)
	if err != nil {
		return nil, err
	}
	g := &managed{srv: srv, key: key, store: store, dataDir: cfg.DataDir, noted: map[string]bool{}, since: time.Now(), done: make(chan struct{}), tracker: NewTracker(), at: map[string]time.Time{}, msgsAt: -1}
	g.lctx, g.cancel = context.WithCancel(context.Background()) // not ctx: the loop lives as long as the server
	safego.Go("opencode:events:"+key, func() { g.loop(g.lctx, m.SkipLast, m.Redact) })
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

// UseSession tells the manager which opencode session an agent was resumed with, so its history and last message are there at once, before its server has said anything (a Coral restart loses the stream's
// state, not the session). An id that is not an opencode session id, or an agent with no server, does nothing.
func (m *Manager) UseSession(key, session string) {
	if !validSessionID(session) {
		return
	}
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil {
		return
	}
	c, err := g.srv.Client()
	if err != nil {
		return
	}
	g.mu.Lock()
	g.session, g.sessionAt = session, time.Now()
	g.noteSession(session)
	g.version++
	g.refreshLast(g.lctx, c, session, m.SkipLast, m.Redact)
	g.mu.Unlock()
}

// rereadEvery is the least time between two reads of an agent's history: a model streaming text sends an event for every few words, and the chat must not read the whole session for each.
var rereadEvery = 3 * time.Second

// noteSession records which store the session is in, once per session. The caller holds g.mu.
func (g *managed) noteSession(session string) {
	if g.noted[session] || len(g.noted) >= 1024 {
		return
	}
	g.noted[session] = true
	noteStore(g.dataDir, session, g.store)
	noteAgentSession(g.dataDir, g.key, session)
}

// lastKeptRunes bounds the text of the kept last message; the route redacts it and shows its first characters.
const lastKeptRunes = 20000

// AgentLastMessage is the newest message the agent's server has given, read when a turn ended and kept: a session list asks for it on every row, so it never reaches the server itself. ok is false until a turn has ended.
func (m *Manager) AgentLastMessage(key string) (Message, bool) {
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil { // no server (asleep, or a Coral restart): what was kept when it last spoke
		return PersistedLast(m.cfg.DataDir, key)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.haveLast {
		return g.last, true
	}
	return PersistedLast(m.cfg.DataDir, key)
}

// AgentMessages is the history of the agent's newest session, oldest first, read through its server's message API. It is read again only when the event stream has said something since the last read, so a chat
// that polls every second costs the server nothing while the agent is idle. ok is false when the agent has no server or its stream has not named a session yet.
func (m *Manager) AgentMessages(ctx context.Context, key string) (msgs []Message, ok bool, err error) {
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil {
		return nil, false, nil
	}
	g.msgsMu.Lock()
	defer g.msgsMu.Unlock()
	g.mu.Lock()
	var session string
	var newest time.Time
	for s, t := range g.at {
		if session == "" || t.After(newest) {
			session, newest = s, t
		}
	}
	if session == "" {
		session = g.session // a resumed agent: its stored session, before any event
	}
	version, have, cached := g.version, g.msgsAt, g.msgs
	g.mu.Unlock()
	if session == "" {
		return nil, false, nil
	}
	g.mu.Lock()
	readAt := g.msgsReadAt
	g.mu.Unlock()
	if have == version || (have != -1 && time.Since(readAt) < rereadEvery) {
		return cached, true, nil // nothing new, or read lately: a stream of text deltas is not a read for each
	}
	c, err := g.srv.Client()
	if err != nil {
		return nil, false, err
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	all, err := c.AllMessages(rctx, session)
	if err != nil {
		return nil, false, err
	}
	g.mu.Lock()
	g.msgs, g.msgsAt, g.msgsReadAt = all, version, time.Now()
	g.reads++
	g.mu.Unlock()
	return all, true, nil
}

// refreshLast reads a session's last message in the background (one read at a time; a turn that ends while one runs is read by the next end). The caller holds g.mu.
func (g *managed) refreshLast(ctx context.Context, c *Client, session string, skip func(Message) bool, redact func(string) (string, bool)) {
	if g.refreshing {
		return
	}
	g.refreshing = true
	safego.Go("opencode:last-message", func() {
		rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		m, ok, err := c.LastMessageSkipping(rctx, session, skip)
		g.mu.Lock()
		g.refreshing = false
		if err == nil && ok {
			if r := []rune(m.Text); len(r) > lastKeptRunes { // far past what a row shows: it is redacted before it is cut to that
				m.Text = string(r[:lastKeptRunes])
			}
			g.last, g.haveLast = m, true
		}
		g.mu.Unlock()
		if err == nil && ok {
			persistLast(g.dataDir, g.key, m, redact) // for the list of an agent that has no server later
		}
	})
}

// AgentSession is AgentTurn for a reader of the history (the indexer): an agent resumed with a stored session is known from the moment UseSession was told, with no state of its own yet (state ""): no turn is
// going on until the stream says so. ok is false when the agent has no session at all.
func (m *Manager) AgentSession(key string) (state State, at time.Time, ok bool) {
	if state, at, ok = m.AgentTurn(key); ok {
		return state, at, true
	}
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil {
		return "", time.Time{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.session == "" {
		return "", time.Time{}, false
	}
	return "", g.sessionAt, true
}

// StoredSession is the newest opencode session the agent named (before a Coral restart, a sleep or a restart of the agent), "" when it has none: what a wake gives its TUI to pick up.
func (m *Manager) StoredSession(key string) string { return StoredSession(m.cfg.DataDir, key) }

// AgentIdleSince says an agent whose server is up and whose stream has never put a session in a state (just launched, or just woken and not yet spoken to) is idle since its server came up: no turn is going on. false
// once the stream has said anything (then its own states decide, and a gap in the stream is unknown, not idle), and for an agent with no server.
func (m *Manager) AgentIdleSince(key string) (time.Time, bool) {
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil {
		return time.Time{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.sawState {
		return time.Time{}, false
	}
	return g.since, true
}

// Keys are the agents that have a server now, in no order.
func (m *Manager) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.servers))
	for k := range m.servers {
		keys = append(keys, k)
	}
	return keys
}

// Stop ends one agent's server and the loop reading it. The key stays reserved until the old server is gone: an Ensure of the same key meanwhile waits, so the old server's shutdown never removes files
// (its pid record, its password) the new one has written into the same folder.
func (m *Manager) Stop(key string) {
	if g, st := m.take(key, nil); g != nil {
		m.stopReserved(key, g, st)
	}
}

// take removes the key's server from the map and reserves the key; nil when there is none, or when want is given and the key's server is not that one.
func (m *Manager) take(key string, want *managed) (*managed, *starting) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.servers[key]
	if g == nil || m.starting[key] != nil || (want != nil && g != want) {
		return nil, nil
	}
	delete(m.servers, key)
	st := &starting{done: make(chan struct{})}
	m.starting[key] = st
	return g, st
}

// stopReserved stops a server taken out of the map and then lets the key be started again.
func (m *Manager) stopReserved(key string, g *managed, st *starting) {
	if m.beforeStop != nil {
		m.beforeStop()
	}
	g.stop()
	m.mu.Lock()
	delete(m.starting, key)
	delete(m.stores, key)
	m.mu.Unlock()
	close(st.done)
}

// Reap stops every server that has been up for at least minAge and whose agent is no longer alive (alive false): an agent that ended, slept or was deleted by a path that never told the manager keeps no
// opencode process. It returns the keys it stopped. A young server is left alone, so one whose agent row is not written yet is never reaped.
func (m *Manager) Reap(alive func(key string) bool, minAge time.Duration) []string {
	type judged struct {
		key string
		g   *managed
	}
	m.mu.Lock()
	var stale []judged
	for key, g := range m.servers {
		if time.Since(g.since) >= minAge {
			stale = append(stale, judged{key, g})
		}
	}
	m.mu.Unlock()
	var stopped []string
	for _, j := range stale {
		if alive(j.key) {
			continue
		}
		// only the server that was judged: one that was stopped and started again for the same agent meanwhile is a new server, with an agent that is alive
		if g, st := m.take(j.key, j.g); g != nil {
			m.stopReserved(j.key, g, st)
			stopped = append(stopped, j.key)
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
	m.alive = alive
	m.reapStop, m.reapDone = make(chan struct{}), make(chan struct{})
	stop, done := m.reapStop, m.reapDone
	m.mu.Unlock()
	safego.Go("opencode:reaper", func() {
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
	})
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
	g.mu.Lock()
	if g.idle != nil {
		g.idle.Stop() // a reader's timer does not outlive it
		g.idle = nil
	}
	g.mu.Unlock()
	g.cancel()
	<-g.done
	g.srv.Stop()
}

// loop reads the event stream until ctx ends. When the stream drops, what it said may be stale: every state is forgotten (Reset) and the stream is read again after a growing pause.
func (g *managed) loop(ctx context.Context, skip func(Message) bool, redact func(string) (string, bool)) {
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
			g.version++
			if session, to, moved := g.tracker.Apply(e); moved {
				g.at[session] = time.Now()
				g.sawState = true
				g.noteSession(session)
				if to == StateIdle || to == StateFailed { // a turn ended: its reply is the new last message
					g.refreshLast(ctx, c, session, skip, redact)
				}
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

// readerCap is how many servers may run only to read a sleeping agent's history at once; readerCooldown is how long a failed start of one is not tried again for the same agent (a chat polls every second).
const readerCap = 2

// The bounds on readers (variables so a test can use small ones): a failed start is not retried for readerCooldown; across the manager at most one reader is started per readerStartGap and one per agent per
// readerAgentGap (anyone who may open a sleeping agent's chat can cause a start, so the starts are bounded and not only the readers that run); a reader stops itself after readerIdle without a read.
var (
	readerCooldown = 30 * time.Second
	readerStartGap = 5 * time.Second
	readerAgentGap = 60 * time.Second
	readerIdle     = 60 * time.Second
)

// ReadHistory is the history of an agent whose server may not be running (asleep, or just after a Coral restart): from its server when one is up, else from a server started only to read it, on the agent's own
// session store with the newest session it named (StoredSession), no TUI and no model call. At most readerCap such servers run, counting those being started; a new one makes room by stopping the oldest of an agent
// that is not awake, or is refused (ok false); starts are bounded too (readerStartGap, readerAgentGap); a failed start is not retried for readerCooldown; a reader stops itself after readerIdle without a read,
// the reaper stops one whose agent sleeps, and a launch replaces one. ok is false when there is nothing to read.
func (m *Manager) ReadHistory(ctx context.Context, key, bin string) ([]Message, bool, error) {
	if msgs, ok, err := m.AgentMessages(ctx, key); ok || err != nil {
		m.touchReader(key)
		return msgs, ok, err
	}
	ses := StoredSession(m.cfg.DataDir, key)
	if ses == "" {
		return nil, false, nil
	}
	if !m.admitReader(key) {
		return nil, false, nil
	}
	defer m.releaseReaderStart(key)
	if _, err := m.ensure(ctx, key, bin, "", ses, true); err != nil {
		m.mu.Lock()
		m.readFail[key] = time.Now()
		m.mu.Unlock()
		return nil, false, nil // a history that cannot be read is an empty chat, not an error
	}
	m.UseSession(key, ses)
	m.touchReader(key)
	return m.AgentMessages(ctx, key)
}

// touchReader notes a read through key's server when it is a reader, and (re)arms the timer that stops it after readerIdle without one.
func (m *Manager) touchReader(key string) {
	m.mu.Lock()
	g := m.servers[key]
	m.mu.Unlock()
	if g == nil || !g.reader {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lastRead = time.Now()
	if g.idle != nil {
		g.idle.Stop()
	}
	g.idle = time.AfterFunc(readerIdle, func() { m.stopIdleReader(key, g) })
}

// stopIdleReader ends a reader that was not read for readerIdle: only the server it was armed for, only while it is still a reader.
func (m *Manager) stopIdleReader(key string, g *managed) {
	g.mu.Lock()
	idle := time.Since(g.lastRead) >= readerIdle
	g.mu.Unlock()
	if !idle {
		return
	}
	if taken, st := m.take(key, g); taken != nil {
		m.stopReserved(key, taken, st)
	}
}

// releaseReaderStart ends the reservation admitReader made for key.
func (m *Manager) releaseReaderStart(key string) {
	m.mu.Lock()
	delete(m.readerStarting, key)
	m.mu.Unlock()
}

// admitReader says whether a server may be started to read key's history now, and reserves the start (it counts against the cap until releaseReaderStart): refused after a failed start, while the manager's or the
// agent's start gap has not passed, or when the cap is reached and no reader of an agent that is not awake can make room (the oldest such is stopped, outside the lock, and the count looked at again).
func (m *Manager) admitReader(key string) bool {
	for attempt := 0; attempt < readerCap+1; attempt++ {
		m.mu.Lock()
		if m.closed || time.Since(m.readFail[key]) < readerCooldown {
			m.mu.Unlock()
			return false
		}
		if m.servers[key] != nil || m.starting[key] != nil || m.readerStarting[key] { // one is up or on its way: it is used
			m.mu.Unlock()
			return true
		}
		if time.Since(m.lastReaderStart) < readerStartGap || time.Since(m.readerStartAt[key]) < readerAgentGap {
			m.mu.Unlock()
			return false // starts are bounded: nothing is started for this open
		}
		type reader struct {
			key   string
			since time.Time
		}
		var readers []reader
		for k, g := range m.servers {
			if g.reader {
				readers = append(readers, reader{k, g.since})
			}
		}
		if len(readers)+len(m.readerStarting) < readerCap {
			now := time.Now()
			m.readerStarting[key] = true
			m.readerStartAt[key], m.lastReaderStart = now, now
			m.mu.Unlock()
			return true
		}
		alive := m.alive
		m.mu.Unlock()
		// outside the lock: the question may read a database
		var victim string
		var oldest time.Time
		for _, r := range readers {
			if alive != nil && alive(r.key) {
				continue // an agent that is awake is not made to give up its server
			}
			if victim == "" || r.since.Before(oldest) {
				victim, oldest = r.key, r.since
			}
		}
		if victim == "" {
			return false
		}
		m.Stop(victim)
	}
	return false
}
