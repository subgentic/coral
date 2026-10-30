// Package operatortouch records the Operator's touches of agents (#11225, for the Analytics tab "Operator interaction"): one row of kind, agent, team and time each time the Operator types to an agent,
// answers its question, wakes, restarts or stops it, or approves its task. It holds no text and no length: the only things that reach a Recorder are which session was touched and what kind of
// touch it was, and the board store's table has no column for anything else (board.TestOperatorTouchHoldsNoText).
package operatortouch

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/logparse"
)

// Store is what the Recorder writes to (board.Store).
type Store interface {
	RecordOperatorTouch(ctx context.Context, team, agent, kind string, at time.Time) error
}

// Resolver says which team and agent a session is: its board and its label there. ok is false for a session that is on no board (a plain terminal, an agent that never joined): it is not recorded.
type Resolver func(ctx context.Context, sessionID string) (team, agent string, ok bool)

// Recorder writes touches. Typed input is coalesced: the keystrokes of one burst (TouchBurst) are one touch.
type Recorder struct {
	store   Store
	resolve Resolver
	now     func() time.Time

	mu   sync.Mutex
	last map[string]time.Time // per session: when it was last touched, of any kind
}

// New makes a Recorder.
func New(store Store, resolve Resolver) *Recorder {
	return &Recorder{store: store, resolve: resolve, now: time.Now, last: map[string]time.Time{}}
}

// SetClock replaces the clock (tests).
func (r *Recorder) SetClock(now func() time.Time) { r.now = now }

// Touch records a touch of kind of the session now. Every kind but typed is one touch each time, and it also starts the burst that typed input is coalesced into (an answer's own keystroke is not
// a second touch).
func (r *Recorder) Touch(ctx context.Context, sessionID, kind string) {
	if r == nil || sessionID == "" {
		return
	}
	r.record(ctx, sessionID, kind, false)
}

// TouchAgent records a touch of an agent known by its label on a team (an approval of its task: no session is at hand).
func (r *Recorder) TouchAgent(ctx context.Context, team, agent, kind string) {
	if r == nil {
		return
	}
	if err := r.store.RecordOperatorTouch(ctx, team, agent, kind, r.now()); err != nil {
		slog.Warn("[analytics] could not record an operator touch", "kind", kind, "error", err)
	}
}

// Typed records that the Operator typed to the session: a touch only when the last touch of it, of any kind, is more than board.TouchBurst ago.
func (r *Recorder) Typed(sessionID string) {
	if r == nil || sessionID == "" {
		return
	}
	r.record(context.Background(), sessionID, board.TouchTyped, true)
}

// TypedTo is Typed for a terminal target named as a session is (claude-<uuid>): the session it names. A target that names none (a plain terminal's) is ignored.
func (r *Recorder) TypedTo(target string) {
	if r == nil {
		return
	}
	if _, sessionID := logparse.ParseSessionName(target); sessionID != "" {
		r.Typed(sessionID)
	}
}

func (r *Recorder) record(ctx context.Context, sessionID, kind string, coalesce bool) {
	now := r.now()
	r.mu.Lock()
	if coalesce {
		if at, ok := r.last[sessionID]; ok && now.Sub(at) < board.TouchBurst {
			r.mu.Unlock()
			return
		}
	}
	r.last[sessionID] = now
	if len(r.last) > 2000 { // sessions come and go: forget the long quiet ones
		for k, at := range r.last {
			if now.Sub(at) > time.Hour {
				delete(r.last, k)
			}
		}
	}
	r.mu.Unlock()
	team, agent, ok := r.resolve(ctx, sessionID)
	if !ok {
		return
	}
	if err := r.store.RecordOperatorTouch(ctx, team, agent, kind, now); err != nil {
		slog.Warn("[analytics] could not record an operator touch", "kind", kind, "error", err)
	}
}
