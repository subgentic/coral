package routes

import "sync"

// One lock per agent, for everything that sends keys to answer or close a prompt on its screen: a person's answer (AnswerPrompt), auto-accept, auto-accept of the recommended
// decision and the dialog timeout. Each re-reads the screen (and the AskID) INSIDE the lock before any key, so two of them can never both act on one prompt. A person's answer waits
// for the lock (lockAgent); the watchers never queue (tryLockAgent): busy means skip this pass.

// agentLocks is the table of per-agent locks, keyed by session id; its zero value is ready. An entry lives only while someone holds or waits for it.
type agentLocks struct {
	mu sync.Mutex
	m  map[string]*agentLock
}

type agentLock struct {
	mu   sync.Mutex
	refs int // holders and waiters
}

// ref returns sid's lock with one more reference.
func (l *agentLocks) ref(sid string) *agentLock {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m == nil {
		l.m = map[string]*agentLock{}
	}
	e := l.m[sid]
	if e == nil {
		e = &agentLock{}
		l.m[sid] = e
	}
	e.refs++
	return e
}

// unref drops one reference, and the entry with the last.
func (l *agentLocks) unref(sid string, e *agentLock) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e.refs--; e.refs == 0 && l.m[sid] == e {
		delete(l.m, sid)
	}
}

// size is how many agents have an entry (for tests).
func (l *agentLocks) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.m)
}

// release is an unlock that does its work once, however often it is called.
func (l *agentLocks) release(sid string, e *agentLock) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			e.mu.Unlock()
			l.unref(sid, e)
		})
	}
}

// lockAgent takes the agent's lock, waiting while another holds it.
func (h *SessionsHandler) lockAgent(sessionID string) (unlock func()) {
	e := h.locks.ref(sessionID)
	e.mu.Lock()
	return h.locks.release(sessionID, e)
}

// tryLockAgent takes the agent's lock only if it is free; ok false means another holds it, and the caller skips this pass.
func (h *SessionsHandler) tryLockAgent(sessionID string) (unlock func(), ok bool) {
	e := h.locks.ref(sessionID)
	if !e.mu.TryLock() {
		h.locks.unref(sessionID, e)
		return nil, false
	}
	return h.locks.release(sessionID, e), true
}
