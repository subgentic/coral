package board

import (
	"context"
	"database/sql"
	"github.com/jmoiron/sqlx"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13138: a compare-and-set whose transaction went stale (another writer committed after its read, so SQLite refuses the upgrade to a write with a busy answer) is the same answer as a changed list, so the caller retries; it is
// never a generic error, and never an overwrite.
func TestASetArtifactTagsIfWhoseSnapshotWentStaleAnswersChangedNotAnError(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	require.NoError(t, s.SetArtifactTags(ctx, "b-aaaaaaaaaa", hex, []string{"a"}))
	other, err := sql.Open("sqlite", s.dbPath+"?_pragma=busy_timeout(1000)&_pragma=journal_mode(WAL)")
	require.NoError(t, err)
	defer other.Close()
	t.Cleanup(func() { tagsCASAfterRead = func() {} })
	tagsCASAfterRead = func() { // a writer on another connection commits after this transaction's read
		_, err := other.Exec(`INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, "b-aaaaaaaaaa", hex, "approved")
		require.NoError(t, err)
	}
	err = s.SetArtifactTagsIf(ctx, "b-aaaaaaaaaa", hex, []string{"a"}, []string{"a", "read"})
	assert.ErrorIs(t, err, ErrArtifactTagsChanged, "a stale snapshot is a changed list")
	tagsCASAfterRead = func() {}
	all, err := s.ArtifactTags(ctx, "b-aaaaaaaaaa")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "approved"}, all[hex], "the other writer's tag stays and the stale write was not made")
}

// QA Reviewer 2's SHOULD on #13138: the busy answer on the COMMIT is mapped too, and only a compare-and-set maps it: a plain local write keeps the raw error, and so does any error that is not busy.
func TestTheBusyMappingOfTheTagsWriteHoldsOnCommitAndOnlyForACompareAndSet(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const board, hex = "b-aaaaaaaaaa", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	require.NoError(t, s.SetArtifactTags(ctx, board, hex, []string{"a"}))

	// a real busy error: a transaction whose snapshot went stale and then writes
	other, err := sql.Open("sqlite", s.dbPath+"?_pragma=busy_timeout(1000)&_pragma=journal_mode(WAL)")
	require.NoError(t, err)
	defer other.Close()
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(t, err)
	var n int
	require.NoError(t, tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM artifact_tags`))
	_, err = other.Exec(`INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, board, hex, "x")
	require.NoError(t, err)
	_, busy := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ?`, board)
	require.Error(t, busy)
	require.True(t, isSQLiteBusy(busy), "%v", busy)
	require.NoError(t, tx.Rollback())

	// the helper: only a check maps a busy; a non-busy error and a local write are the raw error
	assert.ErrorIs(t, tagsWriteErr(true, busy), ErrArtifactTagsChanged)
	assert.Same(t, busy, tagsWriteErr(false, busy), "a plain write keeps the raw busy error")
	other2 := assert.AnError
	assert.Same(t, other2, tagsWriteErr(true, other2), "an error that is not busy is never called a change")

	// the commit: a busy commit of a compare-and-set is a change, of a local write the raw error
	t.Cleanup(func() { commitArtifactTagsTx = func(tx *sqlx.Tx) error { return tx.Commit() } })
	commitArtifactTagsTx = func(tx *sqlx.Tx) error { _ = tx.Rollback(); return busy }
	all, err := s.ArtifactTags(ctx, board)
	require.NoError(t, err)
	err = s.SetArtifactTagsIf(ctx, board, hex, all[hex], []string{"a", "read"})
	assert.ErrorIs(t, err, ErrArtifactTagsChanged, "a busy commit of a compare-and-set")
	err = s.SetArtifactTags(ctx, board, hex, []string{"a", "read"})
	assert.Same(t, busy, err, "a busy commit of a local write is not mapped")
}
