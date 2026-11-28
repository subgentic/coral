package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #22160: the board status read lists active waits without the writer: an expired wait is left out in memory, and the row is expired later by the background pass, so a status read never queues behind
// a long write (coral-hub #286989).
func TestListActiveWaitsNeverTakesTheWriter(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	live, err := s.RegisterWait(ctx, "team", "Live", "s1", "message", "Lead", "", time.Hour)
	require.NoError(t, err)
	gone, err := s.RegisterWait(ctx, "team", "Gone", "s2", "message", "Lead", "", time.Hour)
	require.NoError(t, err)
	_, err = s.db.Exec("UPDATE board_waits SET expires_at=? WHERE id=?", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), gone.ID)
	require.NoError(t, err)

	// Hold the single writer connection, as a prune batch does.
	tx, err := s.db.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer tx.Rollback()

	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	waits, err := s.ListActiveWaits(rctx, "team")
	require.NoError(t, err, "a read must not wait for the writer")
	require.Len(t, waits, 1)
	require.Equal(t, live.ID, waits[0].ID, "the expired wait is left out")
	require.NoError(t, tx.Rollback())

	var status string
	require.NoError(t, s.db.Get(&status, "SELECT status FROM board_waits WHERE id=?", gone.ID))
	require.Equal(t, "active", status, "the read did not write the expiry")

	require.NoError(t, s.DispatchExpiredWaitNotices(ctx, func(RegisteredWait) error { return nil }))
	require.NoError(t, s.db.Get(&status, "SELECT status FROM board_waits WHERE id=?", gone.ID))
	require.Equal(t, "expired", status, "the background pass expires it")
}
