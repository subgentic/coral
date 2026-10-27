package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8915: a claim keeps the thinking level of the agent that made it, from now on; an older claim, a claim with no level and a task that is not in progress record nothing.
func TestAClaimKeepsTheClaimersThinkingLevel(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	_, err = s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "Work", "", "high", "Dev", "Dev")
	require.NoError(t, err)

	got, err := s.ClaimThinking(ctx, "team", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "", got, "a task nobody claimed records nothing")
	require.NoError(t, s.SetClaimThinking(ctx, "team", task.ID, "High"))
	got, _ = s.ClaimThinking(ctx, "team", task.ID)
	assert.Equal(t, "", got, "a pending task is not written: the claim came first")

	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	require.NoError(t, s.SetClaimThinking(ctx, "team", task.ID, "  "))
	got, _ = s.ClaimThinking(ctx, "team", task.ID)
	assert.Equal(t, "", got, "no level is never a guess")
	require.NoError(t, s.SetClaimThinking(ctx, "team", task.ID, " High "))
	got, _ = s.ClaimThinking(ctx, "team", task.ID)
	assert.Equal(t, "high", got, "trimmed and lower-cased")
	require.NoError(t, s.SetClaimThinking(ctx, "other", task.ID, "low"))
	got, _ = s.ClaimThinking(ctx, "team", task.ID)
	assert.Equal(t, "high", got, "another board's call changes nothing")

	_, err = s.CompleteTask(ctx, "team", task.ID, "Dev", nil)
	require.NoError(t, err)
	require.NoError(t, s.SetClaimThinking(ctx, "team", task.ID, "low"))
	got, _ = s.ClaimThinking(ctx, "team", task.ID)
	assert.Equal(t, "high", got, "a finished task keeps the level it was claimed at")
}
