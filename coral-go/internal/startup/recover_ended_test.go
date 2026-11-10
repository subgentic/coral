package startup

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #15062: an agent whose CLI exited (Ended, reason agent_exited) still has its terminal, left at a shell, so the runtime lists it as alive. The start-up recovery of "sleeping sessions that are still alive" woke it,
// and about 25 seconds later the reconciler found the CLI gone again and posted a fresh "stopped" notice: every Coral restart gave the same agent another notice.

type aliveRuntime struct {
	background.AgentRuntime
	ids []string
}

func (a aliveRuntime) ListAgents(context.Context) ([]background.AgentInfo, error) {
	var out []background.AgentInfo
	for _, id := range a.ids {
		out = append(out, background.AgentInfo{SessionID: id, AgentType: "claude"})
	}
	return out, nil
}

func TestStartupRecoveryLeavesAnEndedAgentEndedButWakesAnAutoSleeper(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	ended, slept := "ended-0000-4000-8000-000000000000", "slept-0000-4000-8000-000000000000"
	for _, id := range []string{ended, slept} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentName: id[:5], AgentType: "claude", WorkingDir: t.TempDir()}))
	}
	require.NoError(t, ss.SetSessionSleepingFor(ctx, ended, store.SleepReasonAgentExited))
	require.NoError(t, ss.SetSessionSleepingFor(ctx, slept, store.SleepReasonCoralStopped))

	reconcileOrphanedSessions(ctx, db, aliveRuntime{ids: []string{ended, slept}}, true)

	e, err := ss.GetLiveSession(ctx, ended)
	require.NoError(t, err)
	assert.Equal(t, 1, e.IsSleeping, "its terminal is alive but its CLI is not: it stays Ended (the reconciler wakes it when the CLI runs again)")
	s, err := ss.GetLiveSession(ctx, slept)
	require.NoError(t, err)
	assert.Equal(t, 0, s.IsSleeping, "any other sleeper whose terminal survived is still recovered")
}
