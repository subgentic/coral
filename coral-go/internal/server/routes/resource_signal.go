package routes

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/resources"
)

// ResourceSignal is what Coral knows of an agent's session for the resource queue's watcher (#13705): "prompt" while the agent waits for a person to answer its own request (a permission or approval prompt:
// the hook state for Claude, the rollout for Codex, the session file for Pi), "idle" when its turn is over and nothing is running, "" when it works or is not known. since is when that began.
func (h *SessionsHandler) ResourceSignal(sessionID string) (string, time.Time) {
	if h == nil || h.ts == nil || sessionID == "" {
		return "", time.Time{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st := h.deriveSingleSessionState(ctx, sessionID, 0)
	switch {
	case st.Gone || st.Sleeping || st.NotStarted:
		return "", time.Time{}
	case st.NeedsInput && st.OwnRequest && !st.InTurn:
		since := st.WaitingSince
		if since.IsZero() {
			since = st.Since
		}
		return resources.SignalPrompt, since
	case st.AwaitingUser && !st.NeedsInput && !st.InTurn:
		since := st.LastStop
		if since.IsZero() {
			since = st.Since
		}
		return resources.SignalIdle, since
	}
	return "", time.Time{}
}
