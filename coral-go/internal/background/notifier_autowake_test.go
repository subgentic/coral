package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// The notifier wakes an auto-asleep agent for what is directed at it (a mention, an assigned task) and for nothing else, so a task given to a sleeper is delivered and its nudges follow once it
// is up (#12111). A manual sleeper is never woken, and a broadcast that names no one wakes no one.
func TestNotifierWakesAnAutoAsleepAgentForADirectedItemOnly(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	db, err := sqlx.Open("sqlite", filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE live_sessions (session_id TEXT PRIMARY KEY, is_sleeping INTEGER NOT NULL DEFAULT 0, sleep_reason TEXT)`)
	require.NoError(t, err)
	bs.SetSessionsDB(db)
	const idle, manual = "11111111-1212-4000-8000-0000000000c1", "11111111-1212-4000-8000-0000000000c2"
	_, err = db.Exec(`INSERT INTO live_sessions (session_id, is_sleeping, sleep_reason) VALUES (?, 1, 'idle'), (?, 1, NULL)`, idle, manual)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Dev", "Developer", naming.SessionName("claude", idle), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Sleeper", "Sleeper", naming.SessionName("claude", manual), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)

	n := NewBoardNotifier(bs, &mockRuntime{}, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	var woken []string
	n.SetAutoWakeFn(func(_ context.Context, sid string) bool { woken = append(woken, sid); return true })
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return nil, nil }) // both are asleep: no terminal is live
	pass := func() {
		woken = nil
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}

	_, err = bs.PostMessage(ctx, "p", "Lead", "status for everyone, @all please read it", nil)
	require.NoError(t, err)
	pass()
	assert.Empty(t, woken, "a broadcast wakes no one")

	_, err = bs.PostMessage(ctx, "p", "Lead", "@Dev can you look at this", nil)
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "p", "Lead", "@Sleeper and you", nil)
	require.NoError(t, err)
	pass()
	assert.Equal(t, []string{idle}, woken, "a mention wakes the auto-asleep agent; the manual sleeper stays")
}
