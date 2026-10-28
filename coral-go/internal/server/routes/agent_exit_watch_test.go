package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #10295 (Mobile #10283): the CLI quit on a person's message (MOCK_EXIT, or /exit) and left its shell; the chat kept saying "Working 32 s" with a green dot, because only the reconciler marked the
// agent Ended (two passes, and not in the first minute). After a message it took, or the CLI's SessionEnd, the terminal is looked at within seconds, and an agent that has shown it ran is Ended as soon
// as only its shell is left; a running CLI, and an agent that has sent no event, are never marked.
func TestWatchForExitMarksAnAgentWhoseCLIQuit(t *testing.T) {
	old := exitWatchDelays
	exitWatchDelays = nil // a look every 50 ms for 1.5 s: a slow machine cannot outrun the watch
	for at := 50 * time.Millisecond; at <= 1500*time.Millisecond; at += 50 * time.Millisecond {
		exitWatchDelays = append(exitWatchDelays, at)
	}
	t.Cleanup(func() { exitWatchDelays = old })
	server, h, mock, ss := setupSessionsTestServer(t)
	defer server.Close()
	ctx := context.Background()
	term := newFGTerminal(mock)
	h.terminal = term
	seen := func(sid string) *store.LiveSession {
		ls, err := ss.GetLiveSession(ctx, sid)
		require.NoError(t, err)
		return ls
	}
	register := func(sid, agent string, withEvent bool) string {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: agent, WorkingDir: "/tmp/" + agent}))
		if withEvent {
			id := sid
			_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: agent, SessionID: &id, EventType: "stop", Summary: "stop"})
			require.NoError(t, err)
		}
		return naming.SessionName("claude", sid)
	}

	// 1. the CLI runs for a while, then quits and leaves its shell: Ended within the watch
	const quits = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d"
	name := register(quits, "quits", true)
	term.setFG(name, "node")
	h.watchForExit(name, "claude", quits)
	time.Sleep(80 * time.Millisecond)
	assert.Zero(t, seen(quits).IsSleeping, "a running CLI is not marked")
	term.setFG(name, "zsh")
	require.Eventually(t, func() bool { return seen(quits).IsSleeping == 1 }, 2*time.Second, 20*time.Millisecond, "the agent is Ended within the watch, not at the reconciler's grace")
	require.NotNil(t, seen(quits).SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *seen(quits).SleepReason)

	// 2. an agent that has sent no event is left to the reconciler's launch grace
	const quiet = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
	name = register(quiet, "quiet", false)
	term.setFG(name, "zsh")
	h.watchForExit(name, "claude", quiet)
	time.Sleep(600 * time.Millisecond)
	assert.Zero(t, seen(quiet).IsSleeping, "an agent whose CLI may still be starting is not marked")
	for _, sid := range []string{quits, quiet} { // the watches are over before the test is: no goroutine outlives it
		require.Eventually(t, func() bool { _, on := exitWatching.Load(sid); return !on }, 5*time.Second, 20*time.Millisecond, "the watch of %s ends", sid)
	}
}
