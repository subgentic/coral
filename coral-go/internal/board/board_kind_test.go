package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11076: a board a job used is marked on its row, once, and the backfill marks the boards past job sessions were members of.
func TestJobBoardsAreMarkedAndBackfilled(t *testing.T) {
	s, sessDB := testStoreWithSessionsDB(t)
	ctx := context.Background()
	sessDB.MustExec(`CREATE TABLE IF NOT EXISTS scheduled_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT)`)
	sessDB.MustExec(`ALTER TABLE live_sessions ADD COLUMN is_job INTEGER NOT NULL DEFAULT 0`)

	team, err := s.CreateBoard(ctx, "team", "Operator")
	require.NoError(t, err)
	jobBoard, err := s.CreateBoard(ctx, "used-by-a-job", "Operator")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, team.ID, "Dev", "Dev", "claude-aaaaaaaa-1111-4000-8000-000000000001", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, jobBoard.ID, "Nightly", "Nightly", "claude-bbbbbbbb-2222-4000-8000-000000000002", nil, "all") // a job run that has ended: no live row
	require.NoError(t, err)
	sessDB.MustExec(`INSERT INTO scheduled_runs (session_id) VALUES ('bbbbbbbb-2222-4000-8000-000000000002')`)

	n, err := s.BackfillJobBoards(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	keys, err := s.BoardKeysOfKind(ctx, BoardKindJob)
	require.NoError(t, err)
	assert.Equal(t, []string{jobBoard.ID}, keys, "the job's board is marked, the team's is not")

	changed, err := s.MarkBoardKind(ctx, jobBoard.ID, BoardKindJob)
	require.NoError(t, err)
	assert.False(t, changed, "marked once")
	changed, err = s.MarkBoardKind(ctx, team.ID, BoardKindJob)
	require.NoError(t, err)
	assert.True(t, changed)
	again, err := s.BackfillJobBoards(ctx)
	require.NoError(t, err)
	assert.Equal(t, 0, again, "the backfill is idempotent")
}
