package store

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func aShare(path string) DropboxShare {
	return DropboxShare{Path: path, Digest: "d1", Kind: DropboxShareArtifact, Audience: DropboxSharePublic, AccountID: "dbid:A", Hash: "h1"}
}

// #14944: a share is reserved, copied, made live, stopped and gone; the table never holds the link or who it was shared with.
func TestAShareGoesFromReservedToLiveToGone(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	id, err := ob.ReserveShare(ctx, aShare("/Shared from Coral/Team A/release-plan.md"), now)
	require.NoError(t, err)
	sh, err := ob.Share(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, DropboxSharePreparing, sh.State)
	got, _ := ob.SharesOf(ctx, "d1")
	assert.Empty(t, got, "a share being prepared is not shown as shared")
	n, _ := ob.SharedCount(ctx)
	assert.Equal(t, 1, n, "but Disconnect still counts it")

	require.NoError(t, ob.ShareCopied(ctx, id, "id:copy", "rev1"))
	require.NoError(t, ob.ShareLive(ctx, id, "2026-12-09T10:00:00Z"))
	assert.ErrorIs(t, ob.ShareLive(ctx, id, ""), sql.ErrNoRows, "only a preparing share is made live")
	got, _ = ob.SharesOf(ctx, "d1")
	require.Len(t, got, 1)
	assert.Equal(t, DropboxShareLive, got[0].State)
	assert.Equal(t, "rev1", got[0].Rev)

	require.NoError(t, ob.ShareStopping(ctx, id))
	require.NoError(t, ob.ShareGone(ctx, id))
	n, _ = ob.SharedCount(ctx)
	assert.Zero(t, n)

	var cols []string
	rows, err := ob.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('dropbox_shares')")
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var c string
		require.NoError(t, rows.Scan(&c))
		cols = append(cols, c)
	}
	for _, c := range cols {
		assert.NotContains(t, []string{"url", "link", "email", "emails", "members", "token"}, c, "condition 7: no link, no people, no token")
	}
}

// Condition 10: 20 shares an hour, a stopped one included; the bound frees up after an hour.
func TestSharesAreBoundedTwentyAnHour(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	for i := 0; i < DropboxSharesPerHour; i++ {
		id, err := ob.ReserveShare(ctx, aShare(fmt.Sprintf("/Shared from Coral/T/f%d.md", i)), now)
		require.NoError(t, err)
		require.NoError(t, ob.ShareGone(ctx, id))
	}
	_, err := ob.ReserveShare(ctx, aShare("/Shared from Coral/T/one-more.md"), now)
	assert.ErrorIs(t, err, ErrShareLimit, "a stopped share still counts")
	_, err = ob.ReserveShare(ctx, aShare("/Shared from Coral/T/one-more.md"), now.Add(61*time.Minute))
	assert.NoError(t, err, "an hour later")
}

func TestASharePathIsUsedOnceAndChecked(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	_, err := ob.ReserveShare(ctx, aShare("/Shared from Coral/T/a.md"), time.Now())
	require.NoError(t, err)
	_, err = ob.ReserveShare(ctx, aShare("/Shared from Coral/T/A.md"), time.Now())
	assert.ErrorIs(t, err, ErrShareNameTaken, "Dropbox paths are not case sensitive")
	bad := aShare("/x")
	bad.Audience = "everyone"
	_, err = ob.ReserveShare(ctx, bad, time.Now())
	assert.Error(t, err)
	bad = aShare("/y")
	bad.Kind = "folder"
	_, err = ob.ReserveShare(ctx, bad, time.Now())
	assert.Error(t, err)
}

func TestStaleSharesAreThoseLeftPreparingOrStopping(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	old := time.Now().Add(-time.Hour)
	a, _ := ob.ReserveShare(ctx, aShare("/S/a"), old)
	b, _ := ob.ReserveShare(ctx, aShare("/S/b"), old)
	c, _ := ob.ReserveShare(ctx, aShare("/S/c"), old)
	_, _ = ob.ReserveShare(ctx, aShare("/S/d"), time.Now()) // preparing now: not stale yet
	require.NoError(t, ob.ShareLive(ctx, b, ""))
	require.NoError(t, ob.ShareStopping(ctx, c))
	st, err := ob.StaleShares(ctx, time.Now().Add(-10*time.Minute))
	require.NoError(t, err)
	var ids []int64
	for _, s := range st {
		ids = append(ids, s.ID)
	}
	assert.Equal(t, []int64{a, c}, ids)

	n, err := ob.ForgetShares(ctx)
	require.NoError(t, err)
	assert.Equal(t, 4, n)
}

func TestTheShareAuditKindIsAccepted(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	require.NoError(t, ds.AddAudit(context.Background(), DropboxAudit{Kind: DropboxAuditShare, Reason: DropboxSharePeople, Count: 2}))
}
