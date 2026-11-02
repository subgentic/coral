package background

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #12069: the daily trim removes only what is past the year, says how many, and leaves a record that still checks.
func TestTheActivityTrimRemovesOnlyWhatIsPastTheYearAndReportsTheCount(t *testing.T) {
	s, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	meta := board.ActivityMeta{Actor: "local", Source: "local"}
	for i := 0; i < 3; i++ {
		require.NoError(t, s.RecordActivity(ctx, meta, board.ActApprove, "file", "x", "x", "team-a"))
	}
	j := NewActivityTrim(s)
	j.logger = slog.Default()
	j.now = func() time.Time { return start.Add(10 * 24 * time.Hour) }
	assert.Equal(t, 0, j.RunOnce(ctx), "nothing is a year old")
	j.now = func() time.Time { return time.Now().Add(board.ActivityMaxAge + time.Hour) }
	assert.Equal(t, 3, j.RunOnce(ctx), "the count that went")
	assert.Equal(t, 0, j.RunOnce(ctx), "and the second pass has nothing to remove")
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "%+v", chk)
}
