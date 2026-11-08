package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14655, Dropbox stage 4: the outbox of files to back up.

func outboxRow(path, digest, at string) DropboxOutboxRow {
	return DropboxOutboxRow{Kind: DropboxKindVersion, Digest: digest, DocID: "0123456789abcdef0123456789abcdef", Version: 1, Path: path, ArtifactAt: at}
}

func TestTheOutboxHoldsOneRowPerPath(t *testing.T) {
	db := openTestDB(t)
	ob := NewDropboxOutbox(db)
	ctx := context.Background()
	added, err := ob.Enqueue(ctx, outboxRow("/v1/012/doc/v1-aaaaaaaa.md", "d1", "2026-11-08T10:00:00Z"))
	require.NoError(t, err)
	assert.True(t, added)
	added, err = ob.Enqueue(ctx, outboxRow("/v1/012/doc/v1-aaaaaaaa.md", "d1", "2026-11-08T10:00:00Z"))
	require.NoError(t, err)
	assert.False(t, added, "queued once")
	c, err := ob.Counts(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, c.Pending)
}

func TestTheNewestArtifactsComeFirstAndARetryWaitsItsTurn(t *testing.T) {
	db := openTestDB(t)
	ob := NewDropboxOutbox(db)
	ctx := context.Background()
	for _, r := range []DropboxOutboxRow{outboxRow("/a", "d1", "2026-11-01T00:00:00Z"), outboxRow("/b", "d2", "2026-11-08T00:00:00Z"), outboxRow("/c", "d3", "2026-11-05T00:00:00Z")} {
		_, err := ob.Enqueue(ctx, r)
		require.NoError(t, err)
	}
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	rows, err := ob.Next(ctx, now, 10)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	assert.Equal(t, []string{"/b", "/c", "/a"}, []string{rows[0].Path, rows[1].Path, rows[2].Path}, "newest first")

	require.NoError(t, ob.MarkRetry(ctx, rows[0].ID, now.Add(time.Hour)))
	rows, err = ob.Next(ctx, now, 10)
	require.NoError(t, err)
	assert.Len(t, rows, 2, "a row waiting for its retry time is not handed out")
	rows, err = ob.Next(ctx, now.Add(2*time.Hour), 10)
	require.NoError(t, err)
	assert.Len(t, rows, 3)
	assert.Equal(t, 1, rows[0].Attempts)
}

func TestDoneConflictAndSkippedRowsAreNotHandedOutAgain(t *testing.T) {
	db := openTestDB(t)
	ob := NewDropboxOutbox(db)
	ctx := context.Background()
	for _, p := range []string{"/done", "/conflict", "/skipped", "/queued"} {
		_, err := ob.Enqueue(ctx, outboxRow(p, "d-"+p, "2026-11-08T00:00:00Z"))
		require.NoError(t, err)
	}
	now := time.Now()
	rows, err := ob.Next(ctx, now, 10)
	require.NoError(t, err)
	id := map[string]int64{}
	for _, r := range rows {
		id[r.Path] = r.ID
	}
	require.NoError(t, ob.MarkDone(ctx, id["/done"], "id:abc", "015f", "hash1"))
	require.NoError(t, ob.MarkParked(ctx, id["/conflict"], DropboxOutboxConflict))
	require.NoError(t, ob.MarkParked(ctx, id["/skipped"], DropboxOutboxSkipped))
	rows, err = ob.Next(ctx, now, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "/queued", rows[0].Path)
	c, err := ob.Counts(ctx)
	require.NoError(t, err)
	assert.Equal(t, DropboxOutboxCounts{Pending: 1, BackedUp: 1, Conflict: 1, Skipped: 1}, DropboxOutboxCounts{Pending: c.Pending, BackedUp: c.BackedUp, Conflict: c.Conflict, Skipped: c.Skipped})
	assert.NotEmpty(t, c.LastSync)
	done, err := ob.Done(ctx, "/done")
	require.NoError(t, err)
	assert.Equal(t, "id:abc", done.FileID)
	assert.Equal(t, "015f", done.Rev)
	assert.Equal(t, "hash1", done.ContentHash)
}

func TestADeleteCancelsQueuedRowsButKeepsWhatIsBackedUp(t *testing.T) {
	db := openTestDB(t)
	ob := NewDropboxOutbox(db)
	ctx := context.Background()
	for _, r := range []DropboxOutboxRow{outboxRow("/x/v1", "gone", "2026-11-08T00:00:00Z"), outboxRow("/x/v1.item_data", "gone", "2026-11-08T00:00:00Z"), outboxRow("/y/v1", "kept", "2026-11-08T00:00:00Z"), outboxRow("/z/v1", "gone-done", "2026-11-08T00:00:00Z")} {
		_, err := ob.Enqueue(ctx, r)
		require.NoError(t, err)
	}
	rows, err := ob.Next(ctx, time.Now(), 10)
	require.NoError(t, err)
	for _, r := range rows {
		if r.Path == "/z/v1" {
			require.NoError(t, ob.MarkDone(ctx, r.ID, "id:z", "1", "h"))
		}
	}
	n, err := ob.CancelDigest(ctx, "gone")
	require.NoError(t, err)
	assert.Equal(t, 2, n, "both queued files of the deleted artifact")
	n, err = ob.CancelDigest(ctx, "gone-done")
	require.NoError(t, err)
	assert.Equal(t, 0, n, "a copy already in Dropbox stays until stage 6's explicit removal")
	rows, err = ob.Next(ctx, time.Now(), 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "/y/v1", rows[0].Path)
}

// #14703, Dropbox stage 4b: retention's ledger read takes only done rows of the account, under /v1/, with a stored rev, older than the cut.
// Mutants: each filter of the query dropped in turn.
func TestRetentionsLedgerReadIsNarrow(t *testing.T) {
	db := openTestDB(t)
	ob := NewDropboxOutbox(db)
	ctx := context.Background()
	old := ts(time.Now().Add(-10 * 24 * time.Hour))
	young := ts(time.Now())
	mk := func(path, at, account, rev string, done bool) {
		ok, err := ob.Enqueue(ctx, outboxRow(path, "d-"+path, at))
		require.NoError(t, err)
		require.True(t, ok)
		if done {
			var id int64
			require.NoError(t, db.GetContext(ctx, &id, "SELECT id FROM dropbox_outbox WHERE path = ?", path))
			require.NoError(t, ob.MarkDoneBy(ctx, id, account, 3, "id:"+path, rev, "h"))
		}
	}
	mk("/v1/aaa/due", old, "dbid:A", "r1", true)
	mk("/elsewhere/old", old, "dbid:A", "r1", true)
	mk("/v1/aaa/other-account", old, "dbid:B", "r1", true)
	mk("/v1/aaa/no-rev", old, "dbid:A", "", true)
	mk("/v1/aaa/young", young, "dbid:A", "r1", true)
	mk("/v1/aaa/queued", old, "dbid:A", "r1", false)
	rows, err := ob.DueForRetention(ctx, "dbid:A", time.Now().Add(-7*24*time.Hour), 100)
	require.NoError(t, err)
	var paths []string
	for _, r := range rows {
		paths = append(paths, r.Path)
	}
	assert.Equal(t, []string{"/v1/aaa/due"}, paths)
	n, err := ob.LedgerSize(ctx, "dbid:A")
	require.NoError(t, err)
	assert.Equal(t, 4, n, "the account's done rows")

	// A row in a running job is never put in a second one, and only a done or deleting row takes a retention outcome.
	require.NoError(t, ob.MarkDeleting(ctx, []int64{rows[0].ID}, "job-1"))
	require.NoError(t, ob.MarkDeleting(ctx, []int64{rows[0].ID}, "job-2"))
	jobs, err := ob.Deleting(ctx, "dbid:A")
	require.NoError(t, err)
	require.Len(t, jobs["job-1"], 1)
	assert.Empty(t, jobs["job-2"])
	require.NoError(t, ob.MarkRetention(ctx, rows[0].ID, DropboxOutboxRetainedOut))
	assert.Error(t, ob.MarkRetention(ctx, rows[0].ID, DropboxOutboxQueued))
	c, err := ob.Counts(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, c.RetainedOut)
}
