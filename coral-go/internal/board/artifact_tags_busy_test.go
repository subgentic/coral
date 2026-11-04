package board

import (
	"context"
	"database/sql"
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
