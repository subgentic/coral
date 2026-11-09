package store

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14714, Dropbox stage 5a: edits made in Dropbox, held for the Operator. Each test names the mutant it fails against.

func anEdit(doc, digest string, size int64) DropboxEdit {
	return DropboxEdit{AccountID: "dbid:A", DocID: doc, Version: 1, OrigDigest: "orig-" + doc, Path: "/v1/abc/" + doc + "/v1-00000000.md", Digest: digest, MediaType: "text/markdown", Size: size, Rev: "r-" + digest}
}

// Mutant: Hold inserts a second pending row instead of replacing the first.
func TestRepeatedEditsCollapseIntoTheNewest(t *testing.T) {
	ed := NewDropboxEdits(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, ed.Hold(ctx, anEdit("doc1", "d1", 10)))
	require.NoError(t, ed.Hold(ctx, anEdit("doc1", "d2", 20)))
	open, err := ed.Open(ctx)
	require.NoError(t, err)
	require.Len(t, open, 1)
	assert.Equal(t, "d2", open[0].Digest)
	ds, err := ed.Digests(ctx)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{"d2": true}, ds, "the older pending bytes are no longer held: the prune may take them")
	n, b, err := ed.Stats(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	assert.EqualValues(t, 20, b)
}

// Mutant: Begin moves a row that is not pending (or more than one decision gets through).
func TestAnEditIsDecidedOnceEvenWithTwoClicksAtOnce(t *testing.T) {
	ed := NewDropboxEdits(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, ed.Hold(ctx, anEdit("doc1", "d1", 10)))
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := ed.Begin(ctx, "doc1"); err == nil {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, 1, won, "one decision")
	open, _ := ed.IsOpen(ctx, "doc1")
	assert.True(t, open, "while it is being decided, retention still holds it")
	assert.ErrorIs(t, ed.Hold(ctx, anEdit("doc1", "d9", 1)), ErrNotPending, "a newer edit does not slip in under a decision")
	d, err := ed.Get(ctx, "doc1")
	require.NoError(t, err)
	require.NoError(t, ed.Finish(ctx, d.ID, DropboxEditPromoted, "2"))
	open, _ = ed.IsOpen(ctx, "doc1")
	assert.False(t, open)
	_, err = ed.Begin(ctx, "doc1")
	assert.ErrorIs(t, err, ErrNotPending, "decided: never again")
	assert.Error(t, ed.Finish(ctx, d.ID, "pending", ""), "only the two decisions")
}

// Mutant: Abandon leaves the edit stuck in deciding.
func TestAFailedDecisionPutsTheEditBack(t *testing.T) {
	ed := NewDropboxEdits(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, ed.Hold(ctx, anEdit("doc1", "d1", 10)))
	d, err := ed.Begin(ctx, "doc1")
	require.NoError(t, err)
	require.NoError(t, ed.Abandon(ctx, d.ID))
	_, err = ed.Begin(ctx, "doc1")
	assert.NoError(t, err, "pending again: the Operator can decide it")
}

// The listing cursor belongs to the account connected now: any new sign-in clears it, and a cursor for an account no longer connected is not stored.
func TestTheListingCursorIsTheConnectedAccountsAndClearedOnSignIn(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	require.NoError(t, ds.Save(ctx, "dbid:A", fakeRefresh, "fp"))
	require.NoError(t, ds.SetListCursor(ctx, "dbid:A", "cur-1"))
	c, err := ds.ListCursor(ctx)
	require.NoError(t, err)
	assert.Equal(t, "cur-1", c)
	require.NoError(t, ds.SetListCursor(ctx, "dbid:B", "cur-B"))
	c, _ = ds.ListCursor(ctx)
	assert.Equal(t, "cur-1", c, "not the connected account: not stored")
	require.NoError(t, ds.Save(ctx, "dbid:A", fakeRefresh, "fp"))
	c, _ = ds.ListCursor(ctx)
	assert.Empty(t, c, "a new sign-in, even the same account, lists from the start")
	require.NoError(t, ds.SetListCursor(ctx, "dbid:A", "cur-2"))
	require.NoError(t, ds.Disconnect(ctx))
	c, _ = ds.ListCursor(ctx)
	assert.Empty(t, c)
}

// Mutant: SeenRev forgets a decided edit (it would be fetched and held again).
func TestARevOnceHeldIsNeverHeldAgain(t *testing.T) {
	ed := NewDropboxEdits(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, ed.Hold(ctx, anEdit("doc1", "d1", 10)))
	d, err := ed.Begin(ctx, "doc1")
	require.NoError(t, err)
	require.NoError(t, ed.Finish(ctx, d.ID, DropboxEditSeparate, "newdoc"))
	seen, err := ed.SeenRev(ctx, "doc1", "r-d1")
	require.NoError(t, err)
	assert.True(t, seen)
	seen, _ = ed.SeenRev(ctx, "doc1", "r-other")
	assert.False(t, seen)
}
