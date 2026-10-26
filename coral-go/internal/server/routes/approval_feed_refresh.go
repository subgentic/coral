package routes

import (
	"context"
	"sync"
	"time"
)

type approvalFeedRefresh struct {
	mu      sync.Mutex
	pending map[string]*time.Timer
}

func (c *displayScreenCache) forget(id string) {
	c.mu.Lock()
	delete(c.entries, id)
	c.mu.Unlock()
}

// A confirmed answer is a reason to read the screen again, never a reason to
// resolve a permission request. Long native calls may emit no closing hook until
// completion; without this kick the dashboard waits for the five-second tick.
func (h *SessionsHandler) refreshAfterConfirmedAnswer(ctx context.Context, agentType, sessionID string) {
	if agentType != "codex" || sessionID == "" {
		return
	}
	h.displayScreens.forget(sessionID)
	h.kickWS() // invalidates the shared list too, including a pre-answer build

	// If the request is still settling, the immediate read must stay attention.
	// One additional read at request+3s avoids waiting for a periodic tick. The
	// ordinary hint guards recheck the current request, screen and freshness;
	// neither this timer nor the answer supplies positive display evidence.
	events, err := h.ts.GetSessionStateEvents(ctx, []string{sessionID})
	if err != nil {
		return
	}
	var requested time.Time
	for _, event := range events[sessionID] {
		e := event.StateEvent()
		if e.Type == "permission_request" && e.At.After(requested) {
			requested = e.At
		}
	}
	delay := time.Until(requested.Add(displayHintSettle))
	refresh := &h.approvalRefresh
	refresh.mu.Lock()
	defer refresh.mu.Unlock()
	if previous := refresh.pending[sessionID]; previous != nil {
		previous.Stop()
		delete(refresh.pending, sessionID)
	}
	if requested.IsZero() || delay <= 0 || delay > displayHintSettle {
		return
	}
	if refresh.pending == nil {
		refresh.pending = make(map[string]*time.Timer)
	}
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		refresh.mu.Lock()
		if refresh.pending[sessionID] != timer {
			refresh.mu.Unlock()
			return
		}
		delete(refresh.pending, sessionID)
		refresh.mu.Unlock()
		h.displayScreens.forget(sessionID)
		h.kickWS()
	})
	refresh.pending[sessionID] = timer
}
