package board

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19744: the free label is picked and taken in one statement, so renames at once never share one.
func TestRenameBoardToFreeNeverGivesTwoBoardsTheSameLabel(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })

	const n = 12
	ids := make([]string, n)
	for i := range ids {
		b, err := s.CreateBoard(ctx, "alpha", "Operator")
		require.NoError(t, err)
		ids[i] = b.ID
	}
	labels := make([]string, n)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			l, err := s.RenameBoardToFree(ctx, ids[i], "alpha-2026-11-18")
			assert.NoError(t, err)
			labels[i] = l
		}(i)
	}
	wg.Wait()
	seen := map[string]bool{}
	for _, l := range labels {
		assert.False(t, seen[l], "the label %q went to two boards", l)
		seen[l] = true
	}
	assert.True(t, seen["alpha-2026-11-18"], "the first takes the plain dated name")
	assert.True(t, seen["alpha-2026-11-18-2"], "the next takes -2")
	for i, id := range ids {
		b, err := s.GetBoard(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, labels[i], b.Label, "the label returned is the one stored")
	}
	_, err = s.RenameBoardToFree(ctx, "b-nothere", "x")
	assert.ErrorIs(t, err, ErrBoardNotFound)
}
