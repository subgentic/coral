package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// exitWatchDelays are the moments, counted from a person's accepted message or from the CLI's SessionEnd, at which the agent's terminal is looked at (#10295): the CLI may quit
// on that very message (/exit) and leave its shell, and the reconciler, which waits two passes and the launch minute, would leave "Working" and a green dot up for a minute or more.
// A var so a test can shorten them.
var exitWatchDelays = []time.Duration{time.Second, 3 * time.Second, 6 * time.Second, 12 * time.Second, 25 * time.Second}

// exitWatching holds the sessions with a watch running: one at a time each, so a person typing fast does not start a goroutine per message.
var exitWatching sync.Map

// watchForExit looks at an agent's terminal a few times after a message it took (or after its SessionEnd hook) and marks it Ended as soon as its CLI is gone and only its shell is left,
// the same process signal the reconciler and the nudges use (ptymanager.AgentExited), but with no launch grace: the agent has already shown it ran (it sent hook events), and the person is
// watching. An agent that has sent no event is left to the reconciler (its CLI may still be starting).
func (h *SessionsHandler) watchForExit(name, agentType, sessionID string) {
	if sessionID == "" || h.ss == nil {
		return
	}
	if _, running := exitWatching.LoadOrStore(sessionID, true); running {
		return
	}
	// Timers, not a goroutine that sleeps: a watch waiting for its next look holds no goroutine, so nothing outlives a handler that is gone (the tests' leak check, #4167).
	var look func(i int, last time.Duration)
	look = func(i int, last time.Duration) {
		if i >= len(exitWatchDelays) {
			exitWatching.Delete(sessionID)
			return
		}
		at := exitWatchDelays[i]
		time.AfterFunc(at-last, func() {
			defer safego.Recover("exit-watch")
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if !h.agentHasNoEvents(ctx, sessionID) && h.markEndedAfterFailedSend(ctx, name, agentType, sessionID) {
				exitWatching.Delete(sessionID)
				return
			}
			look(i+1, at) // an agent with no event yet: the reconciler's grace applies; a running CLI: looked at again
		})
	}
	look(0, 0)
}
