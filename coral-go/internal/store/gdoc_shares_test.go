package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Slice B of #20010: the Docs a series was shared to live in the store, not in a JSON file.
func TestGdocSharesAreKeptInTheStore(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	t0 := time.Unix(1_800_000_000, 0)

	g, err := ss.GetGdocShare(ctx, "s1")
	require.NoError(t, err)
	assert.Nil(t, g, "nothing shared yet")

	require.NoError(t, ss.SaveGdocShare(ctx, store.GdocShare{Key: "s1", DocID: "doc-1", Digest: "d1", Name: "plan.md"}, t0))
	g, err = ss.GetGdocShare(ctx, "s1")
	require.NoError(t, err)
	require.NotNil(t, g)
	assert.Equal(t, "doc-1", g.DocID)
	assert.Equal(t, store.GdocShareLive, g.State, "a new share is live")

	ok, err := ss.SetGdocShareState(ctx, "s1", store.GdocSharePaused)
	require.NoError(t, err)
	assert.True(t, ok)
	require.NoError(t, ss.SaveGdocShare(ctx, store.GdocShare{Key: "s1", DocID: "doc-1", Digest: "d2", Name: "plan.md", DocRevision: "r2"}, t0.Add(time.Minute)))
	g, _ = ss.GetGdocShare(ctx, "s1")
	assert.Equal(t, store.GdocSharePaused, g.State, "a later sync keeps the owner's pause")
	assert.Equal(t, "d2", g.Digest)
	assert.Equal(t, "r2", g.DocRevision)

	ok, err = ss.SetGdocShareState(ctx, "nope", store.GdocShareLive)
	require.NoError(t, err)
	assert.False(t, ok)
	_, err = ss.SetGdocShareState(ctx, "s1", "weird")
	assert.Error(t, err)
	assert.Error(t, ss.SaveGdocShare(ctx, store.GdocShare{Key: "", DocID: "x"}, t0))

	require.NoError(t, ss.SaveGdocShare(ctx, store.GdocShare{Key: "s0", DocID: "doc-0"}, t0.Add(-time.Hour)))
	all, err := ss.ListGdocShares(ctx)
	require.NoError(t, err)
	require.Len(t, all, 2)
	assert.Equal(t, "s0", all[0].Key, "oldest first")

	ok, err = ss.DeleteGdocShare(ctx, "s1")
	require.NoError(t, err)
	assert.True(t, ok)
	g, _ = ss.GetGdocShare(ctx, "s1")
	assert.Nil(t, g)
}

// An install that already has gdoc_comment_map without the seen column (an earlier build of this feature) gets it on start, every old row counted as seen.
func TestGdocCommentMapGainsTheSeenColumnOnAnOlderDatabase(t *testing.T) {
	path := t.TempDir() + "/s.db"
	ctx := context.Background()
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `DROP TABLE gdoc_comment_map`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `CREATE TABLE gdoc_comment_map (doc_id TEXT NOT NULL, remote_id TEXT NOT NULL, comment_id INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (doc_id, remote_id))`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO gdoc_comment_map (doc_id, remote_id, comment_id) VALUES ('d', 'c1', 7)`)
	require.NoError(t, err)
	db2, err := storetest.Open(t, path) // a start of the upgraded build
	require.NoError(t, err)
	got, err := store.NewSessionStore(db2).GdocCommentMap(ctx, "d")
	require.NoError(t, err)
	require.Contains(t, got, "c1")
	assert.True(t, got["c1"].Seen)
}
