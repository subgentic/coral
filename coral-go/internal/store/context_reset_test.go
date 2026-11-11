package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15066: after Coral sends an agent /compact or /clear, the stored context reading is dropped until a newer model turn is recorded.
func TestAContextResetDropsTheReadingUntilANewerTurnIsRecorded(t *testing.T) {
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(t.TempDir(), "s.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	s := NewTokenUsageStore(db)
	const a, b = "sess-a", "sess-b"
	insert := func(id string, input int, at time.Time) {
		_, err := db.Exec(`INSERT INTO token_usage (session_id, agent_name, agent_type, input_tokens, cache_read_tokens, total_tokens, num_turns, recorded_at, source) VALUES (?, 'x', 'claude', ?, 0, ?, 1, ?, 'jsonl')`,
			id, input, input, at.UTC().Format("2006-01-02T15:04:05.000000+00:00"))
		require.NoError(t, err)
	}
	insert(a, 300000, time.Now().Add(-time.Hour))
	insert(b, 250000, time.Now().Add(-time.Hour))
	got, err := s.GetLatestTurnContextBySessionIDs(ctx, []string{a, b})
	require.NoError(t, err)
	require.Equal(t, 300000, got[a])
	require.Equal(t, 250000, got[b])

	require.NoError(t, s.MarkContextReset(ctx, a))
	got, err = s.GetLatestTurnContextBySessionIDs(ctx, []string{a, b})
	require.NoError(t, err)
	_, has := got[a]
	assert.False(t, has, "the reset agent shows no reading: the old turn is not its context any more")
	assert.Equal(t, 250000, got[b], "another agent's reading is untouched")

	// The reset is stored: another store on the same database (a restart) sees it, and its time.
	at := NewTokenUsageStore(db).ContextResetsAt(ctx, []string{a, b})
	require.Contains(t, at, a)
	assert.NotContains(t, at, b)
	assert.WithinDuration(t, time.Now(), at[a], time.Minute)

	// The agent's next model turn is recorded after the reset and fills the reading again.
	insert(a, 40000, time.Now().Add(time.Minute))
	got, err = s.GetLatestTurnContextBySessionIDs(ctx, []string{a})
	require.NoError(t, err)
	assert.Equal(t, 40000, got[a])
}
