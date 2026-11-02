package background

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The first turn after an auto-wake is measured once (#12111): the cache tokens it wrote and read, counters only; a turn before the wake and the turns after the first are not.
func TestFirstTurnAfterAutoWakeIsLoggedOnce(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s1", AgentType: "claude", AgentName: "a", WorkingDir: "/tmp"}))
	woke := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	require.NoError(t, ss.SetSessionAutoSleeping(ctx, "s1", woke.Add(-time.Hour)))
	require.NoError(t, ss.NoteAutoWoken(ctx, "s1", woke))
	var buf bytes.Buffer
	p := &TokenPoller{sessionStore: ss, logger: slog.New(slog.NewTextHandler(&buf, nil))}

	p.noteFirstTurnAfterAutoWake(ctx, "s1", woke.Add(-time.Minute).Format(time.RFC3339), 1, 1, 1)
	assert.NotContains(t, buf.String(), "auto_wake_first_turn", "a turn from before the wake is not the first after it")
	p.noteFirstTurnAfterAutoWake(ctx, "s1", woke.Add(40*time.Second).Format(time.RFC3339), 51000, 120, 7)
	assert.Contains(t, buf.String(), "auto_wake_first_turn")
	assert.Contains(t, buf.String(), "cache_write_tokens=51000")
	assert.Contains(t, buf.String(), "seconds_after_wake=40")
	buf.Reset()
	p.noteFirstTurnAfterAutoWake(ctx, "s1", woke.Add(90*time.Second).Format(time.RFC3339), 10, 20, 1)
	assert.Empty(t, buf.String(), "logged once")
	// a new auto-wake starts the count again
	require.NoError(t, ss.NoteAutoWoken(ctx, "s1", woke.Add(time.Hour)))
	p.noteFirstTurnAfterAutoWake(ctx, "s1", woke.Add(time.Hour+time.Second).Format(time.RFC3339), 5, 5, 5)
	assert.Contains(t, buf.String(), "auto_wake_first_turn")
}
