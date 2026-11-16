package board

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

// HasPosted asks EXISTS, not COUNT(*) ... LIMIT 1, which limits nothing: the count walks every row of the member (#18150).
func TestHasPostedUsesExists(t *testing.T) {
	src, err := os.ReadFile("store_messages.go")
	require.NoError(t, err)
	i := strings.Index(string(src), "func (s *Store) HasPosted")
	require.GreaterOrEqual(t, i, 0)
	body := string(src)[i:]
	body = body[:strings.Index(body, "\n}\n")]
	assert.Contains(t, body, "SELECT EXISTS(")
	assert.NotContains(t, body, "COUNT(*)")
}
