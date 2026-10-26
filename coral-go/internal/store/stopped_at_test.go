package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStoppedAt_NullOnRegister(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-1",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	ls, err := ss.GetLiveSession(ctx, "sess-1")
	require.NoError(t, err)
	assert.Nil(t, ls.StoppedAt, "stopped_at should be nil on fresh session")
}

func TestStoppedAt_SetOnUnregister(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-2",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	beforeStop := time.Now().UTC()
	err = ss.UnregisterLiveSession(ctx, "sess-2")
	require.NoError(t, err)

	// Query directly since GetLiveSession filters by status='active'
	var stoppedAt *string
	err = db.GetContext(ctx, &stoppedAt,
		"SELECT stopped_at FROM live_sessions WHERE session_id = ?", "sess-2")
	require.NoError(t, err)
	require.NotNil(t, stoppedAt, "stopped_at should be set after unregister")

	parsed, err := time.Parse(time.RFC3339Nano, *stoppedAt)
	require.NoError(t, err)
	assert.WithinDuration(t, beforeStop, parsed, 2*time.Second,
		"stopped_at should be close to current time")
}

func TestStoppedAt_SetOnReplace(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	// Register original session
	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-old",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	// Replace with new session
	err = ss.ReplaceLiveSession(ctx, "sess-old", &LiveSession{
		SessionID:  "sess-new",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	// Old session should have stopped_at set
	var stoppedAt *string
	err = db.GetContext(ctx, &stoppedAt,
		"SELECT stopped_at FROM live_sessions WHERE session_id = ?", "sess-old")
	require.NoError(t, err)
	require.NotNil(t, stoppedAt, "old session stopped_at should be set after replace")

	// New session should NOT have stopped_at
	var newStoppedAt *string
	err = db.GetContext(ctx, &newStoppedAt,
		"SELECT stopped_at FROM live_sessions WHERE session_id = ?", "sess-new")
	require.NoError(t, err)
	assert.Nil(t, newStoppedAt, "new session stopped_at should be nil")
}

func TestGetSessionDuration_ActiveSession(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-active",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	duration, err := ss.getSessionDuration(ctx, "sess-active")
	require.NoError(t, err)
	assert.GreaterOrEqual(t, duration, 0.0, "active session duration should be >= 0")
	assert.Less(t, duration, 5.0, "freshly created session should be < 5s")
}

func TestGetSessionDuration_StoppedSession(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	// Register and immediately stop
	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-stopped",
		AgentType:  "claude",
		AgentName:  "test-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	// Wait a moment so duration > 0
	time.Sleep(50 * time.Millisecond)

	err = ss.UnregisterLiveSession(ctx, "sess-stopped")
	require.NoError(t, err)

	duration, err := ss.getSessionDuration(ctx, "sess-stopped")
	require.NoError(t, err)
	assert.Greater(t, duration, 0.0, "stopped session should have positive duration")
	assert.Less(t, duration, 5.0, "short session should be < 5s")
}

func TestGetSessionDuration_NonExistent(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	_, err := ss.getSessionDuration(ctx, "nonexistent")
	assert.Error(t, err, "nonexistent session should return error")
}

func TestGetRecentStoppedSessions(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	// Register and stop two sessions
	for _, id := range []string{"sess-a", "sess-b"} {
		err := ss.RegisterLiveSession(ctx, &LiveSession{
			SessionID:  id,
			AgentType:  "claude",
			AgentName:  "agent-" + id,
			WorkingDir: "/tmp",
		})
		require.NoError(t, err)
		err = ss.UnregisterLiveSession(ctx, id)
		require.NoError(t, err)
	}

	// Register active session (should not appear)
	err := ss.RegisterLiveSession(ctx, &LiveSession{
		SessionID:  "sess-active",
		AgentType:  "claude",
		AgentName:  "active-agent",
		WorkingDir: "/tmp",
	})
	require.NoError(t, err)

	// Get recent stopped sessions
	since := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	stopped, err := ss.getRecentStoppedSessions(ctx, since, 10)
	require.NoError(t, err)
	assert.Len(t, stopped, 2, "should return 2 stopped sessions")

	// All should have stopped_at set
	for _, s := range stopped {
		assert.NotNil(t, s.StoppedAt, "stopped session should have stopped_at")
	}
}

func TestGetRecentStoppedSessions_Empty(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()

	stopped, err := ss.getRecentStoppedSessions(ctx, "", 10)
	require.NoError(t, err)
	assert.Empty(t, stopped)
}

func TestStoppedAt_ColumnMigration(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	// Verify column exists by inserting with stopped_at
	_, err := db.ExecContext(ctx, `
		INSERT INTO live_sessions (session_id, agent_type, agent_name, working_dir, created_at, stopped_at)
		VALUES ('test-migration', 'claude', 'test', '/tmp', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
	`)
	require.NoError(t, err)

	var stoppedAt string
	err = db.GetContext(ctx, &stoppedAt,
		"SELECT stopped_at FROM live_sessions WHERE session_id = ?", "test-migration")
	require.NoError(t, err)
	assert.Equal(t, "2026-01-01T01:00:00Z", stoppedAt)
}
