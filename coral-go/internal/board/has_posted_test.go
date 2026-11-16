package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHasPostedIsTrueOnlyForAMemberThatPostedOnTheBoard(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	_, err = s.Subscribe(ctx, "proj", "Beta Tester", "Beta Tester", "sess-1", nil, "all")
	require.NoError(t, err)
	assert.False(t, s.HasPosted(ctx, "proj", "Beta Tester"))
	_, err = s.PostMessage(ctx, "proj", "Beta Tester", "hello", nil)
	require.NoError(t, err)
	assert.True(t, s.HasPosted(ctx, "proj", "Beta Tester"))
	assert.False(t, s.HasPosted(ctx, "other", "Beta Tester"), "another board")
}
