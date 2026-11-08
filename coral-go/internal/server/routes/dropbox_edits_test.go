package routes

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// #14714, Dropbox stage 5a: edits made in Dropbox, against the fake Dropbox. Each test names the mutant it fails against.

// newDropboxEditEnv backs up n text artifacts and runs a first listing (which sees nothing new and stores the cursor).
func newDropboxEditEnv(t *testing.T, n int) (*backupEnv, []string) {
	t.Helper()
	be := newBackupEnv(t)
	var ds []string
	for i := 0; i < n; i++ {
		ds = append(ds, be.put(fmt.Sprintf("doc%d.md", i), "text/markdown", fmt.Sprintf("# doc %d\n", i)))
	}
	be.pass()
	require.Len(t, be.dbx.files, 2*n)
	be.b.Notice(context.Background())
	require.Empty(t, be.dbx.downloads, "the first listing fetches nothing")
	return be, ds
}

// versionFile is the Dropbox path of an artifact's version file.
func (be *backupEnv) versionFile(d string) string {
	be.t.Helper()
	for p := range be.dbx.files {
		if strings.Contains(p, "/v1-"+d[:8]) && !strings.HasSuffix(p, ".item_data.json") {
			return p
		}
	}
	be.t.Fatalf("no version file for %s", d[:8])
	return ""
}

func (be *backupEnv) open() []store.DropboxEdit {
	be.t.Helper()
	e, err := be.b.edits.Open(context.Background())
	require.NoError(be.t, err)
	return e
}

func (be *backupEnv) notice() { be.b.Notice(context.Background()) }

// hasRecord reports whether any upload record names the digest.
func (be *backupEnv) hasRecord(digest string) bool {
	found := false
	forEachUploadRecord(be.h.dbx.dataDir, func(_, d string, _ agentUploadRecord) bool {
		if d == digest {
			found = true
		}
		return !found
	})
	return found
}

// Mutants: an edit is not fetched; it gets an upload record; the original changes.
func TestAnEditIsHeldWithNoRecordAndTheOriginalUntouched(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 2)
	p := be.versionFile(ds[0])
	rev := be.dbx.edit(p, []byte("# doc 0, edited in Dropbox\n"))
	be.notice()
	assert.Equal(t, []string{rev}, be.dbx.downloads, "exactly the listed rev")
	open := be.open()
	require.Len(t, open, 1)
	e := open[0]
	assert.Equal(t, store.DropboxEditPending, e.State)
	assert.Equal(t, ds[0], e.OrigDigest)
	assert.Equal(t, "text/markdown", e.MediaType, "text stays text")
	b, err := os.ReadFile(be.objectPath(e.Digest))
	require.NoError(t, err)
	assert.Equal(t, "# doc 0, edited in Dropbox\n", string(b))
	assert.False(t, be.hasRecord(e.Digest), "no upload record: invisible to every list, search, link, grant, agent and Hub route")
	orig, err := os.ReadFile(be.objectPath(ds[0]))
	require.NoError(t, err)
	assert.Equal(t, "# doc 0\n", string(orig), "the original never changes")
	assert.True(t, be.hasRecord(ds[0]))
	st, _ := be.status()["edits"].(map[string]any)
	assert.EqualValues(t, 1, st["open"])
	matches, _ := filepath.Glob(filepath.Join(be.h.dbx.dataDir, "artifacts", "objects", artifactUploadTempP+"*"))
	assert.Empty(t, matches, "no temp file left")
}

// Mutant: an equal content hash is downloaded anyway (Security's MUST B).
func TestATouchFetchesNothing(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 2)
	p := be.versionFile(ds[0])
	be.dbx.touch(p)
	be.notice()
	assert.Empty(t, be.dbx.downloads)
	assert.Empty(t, be.open())
	row, err := be.b.outbox.ByPath(context.Background(), p)
	require.NoError(t, err)
	assert.Equal(t, be.dbx.revs[p], row.Rev, "the new rev is recorded, so it is not looked at again")
}

// Mutants: a sidecar, a path outside the ledger, or another account's row is read back.
func TestOnlyThisAccountsVersionFilesAreLookedAt(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 3)
	ctx := context.Background()
	side := strings.TrimSuffix(be.versionFile(ds[0]), ".md") + ".item_data.json"
	be.dbx.edit(side, []byte(`{"name":"evil"}`))
	be.dbx.edit("/v1/abc/0123456789abcdef0123456789abcdef/v1-deadbeef.md", []byte("not ours"))
	other := be.versionFile(ds[1])
	_, err := be.db.ExecContext(ctx, "UPDATE dropbox_outbox SET account_id = 'dbid:OLD' WHERE digest = ?", ds[1])
	require.NoError(t, err)
	be.dbx.edit(other, []byte("another account's"))
	be.notice()
	assert.Empty(t, be.dbx.downloads)
	assert.Empty(t, be.open())
}

// Mutants: a deletion of a done file is not queued again; a row retention removed is queued again.
func TestADeletedVersionIsSentAgainUnlessRetentionRemovedIt(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 2)
	ctx := context.Background()
	gone := be.versionFile(ds[0])
	retained := be.versionFile(ds[1])
	r, _ := be.b.outbox.ByPath(ctx, retained)
	require.NoError(t, be.b.outbox.MarkRetention(ctx, r.ID, store.DropboxOutboxRetainedOut))
	be.dbx.remove(gone)
	be.dbx.remove(retained)
	be.notice()
	g, _ := be.b.outbox.ByPath(ctx, gone)
	assert.Equal(t, store.DropboxOutboxQueued, g.State, "the local copy is here: sent again")
	r, _ = be.b.outbox.ByPath(ctx, retained)
	assert.Equal(t, store.DropboxOutboxRetainedOut, r.State, "retention's delete is not undone")
	be.pass()
	assert.Contains(t, be.dbx.files, gone)
	assert.NotContains(t, be.dbx.files, retained)
}

// Mutants: the per-pass and the open bounds are dropped (Security's MUST A).
func TestEditsAreBoundedAndNoneIsLost(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 30)
	be.b.editBounds = editBounds{maxOpen: 25, perPass: 10, maxOpenBytes: 1 << 30, passBytes: 1 << 30}
	for i, d := range ds {
		be.dbx.edit(be.versionFile(d), []byte(fmt.Sprintf("edited %d", i)))
	}
	be.notice()
	assert.Len(t, be.dbx.downloads, 10, "at most 10 fetches a pass")
	assert.Len(t, be.open(), 10)
	st, _ := be.status()["edits"].(map[string]any)
	assert.EqualValues(t, 20, st["waiting"], "the status says how many edits wait in Dropbox")
	be.notice()
	be.notice()
	be.notice()
	assert.Len(t, be.open(), 25, "never more than 25 open")
	assert.Len(t, be.dbx.downloads, 25, "and nothing fetched beyond it")
	// Deciding some (stage 5a's second piece) frees room: the listing finds the rest again.
	open := be.open()
	for _, e := range open[:10] {
		_, err := be.b.edits.Begin(context.Background(), e.DocID)
		require.NoError(t, err)
		require.NoError(t, be.b.edits.Finish(context.Background(), e.ID, store.DropboxEditSeparate, "x"))
	}
	be.notice()
	assert.Len(t, be.open(), 20, "the five that waited are held now")
}

// Mutants: the byte bounds are dropped.
func TestEditBytesAreBounded(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 4)
	be.b.editBounds = editBounds{maxOpen: 100, perPass: 100, maxOpenBytes: 1 << 30, passBytes: 25}
	for _, d := range ds {
		be.dbx.edit(be.versionFile(d), []byte(strings.Repeat("x", 10)))
	}
	be.notice()
	assert.Len(t, be.open(), 2, "25 bytes a pass: two edits of 10")
	be.b.editBounds = editBounds{maxOpen: 100, perPass: 100, maxOpenBytes: 30, passBytes: 1 << 30}
	be.notice()
	assert.Len(t, be.open(), 3, "30 bytes held in all: one more")
}

// Mutants: a declared size over the cap is read; a longer stream than declared is stored (Security's MUST C).
func TestAnEditIsCappedByWhatIsRead(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 2)
	be.dbx.edit(be.versionFile(ds[0]), []byte("small"))
	be.dbx.lieSize = 5
	be.dbx.extraBytes = []byte(strings.Repeat("y", 100)) // the stream carries 105 bytes for a declared 5
	be.notice()
	assert.Empty(t, be.open(), "the bytes are not the listed file")
	matches, _ := filepath.Glob(filepath.Join(be.h.dbx.dataDir, "artifacts", "objects", artifactUploadTempP+"*"))
	assert.Empty(t, matches, "the temp file is removed on failure")

	be.dbx.lieSize, be.dbx.extraBytes = 0, nil
	big := be.versionFile(ds[1])
	be.dbx.mu.Lock()
	be.dbx.changes = append(be.dbx.changes, map[string]any{".tag": "file", "path_lower": big, "rev": "huge", "size": dropboxEditMaxSize + 1, "content_hash": "x"})
	be.dbx.mu.Unlock()
	n := len(be.dbx.downloads)
	be.notice()
	assert.Len(t, be.dbx.downloads, n, "a declared size over 64 MiB is never downloaded")
}

// Mutant: the type comes from the original or the path, not the bytes (Security's MUST D).
func TestAnEditsTypeComesFromItsBytes(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 1)
	be.dbx.edit(be.versionFile(ds[0]), []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"))
	be.notice()
	open := be.open()
	require.Len(t, open, 1)
	assert.Equal(t, "application/octet-stream", open[0].MediaType, "a .md replaced by an image is .bin")
	assert.Equal(t, "text/markdown", typeByBytes("text/markdown", []byte("# héllo")))
	assert.Equal(t, "application/octet-stream", typeByBytes("text/markdown", []byte("a\x00b")))
	assert.Equal(t, "image/png", typeByBytes("image/png", []byte("\x89PNG\r\n\x1a\n")))
	assert.Equal(t, "application/octet-stream", typeByBytes("image/png", []byte("GIF89a")))
	assert.Equal(t, "application/octet-stream", typeByBytes("text/html", []byte("<p>")), "a type outside the closed map is never kept")
}

// Mutant: a newer edit adds a second pending row, or the same rev is fetched again after a reset.
func TestRepeatedEditsCollapseAndAResetFetchesNothingKnown(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 1)
	p := be.versionFile(ds[0])
	be.dbx.edit(p, []byte("first edit"))
	be.notice()
	be.dbx.edit(p, []byte("second edit"))
	be.notice()
	open := be.open()
	require.Len(t, open, 1)
	b, _ := os.ReadFile(be.objectPath(open[0].Digest))
	assert.Equal(t, "second edit", string(b), "the newest")
	n := len(be.dbx.downloads)
	be.dbx.resetNext = true
	be.notice()
	assert.Len(t, be.dbx.downloads, n, "a reset lists again and fetches nothing it holds")
}

// Mutant: keepDoc ignores open edits (Security's MUST on #14703, in this commit).
func TestRetentionKeepsADocumentWithAnOpenEdit(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 4)
	be.b.retainPoll, be.b.retainWait = 1, 1
	be.dbx.edit(be.versionFile(ds[0]), []byte("edited"))
	be.notice()
	require.Len(t, be.open(), 1)
	be.age(10, ds[0], ds[1])
	be.retain(1)
	for _, call := range be.dbx.deleteCalls {
		for _, p := range call {
			assert.False(t, strings.Contains(p, "/v1-"+ds[0][:8]), "the edited document is kept: %s", p)
		}
	}
	assert.Equal(t, 2, be.counts().RetainedOut, "the other old document goes")
}

// Mutant: the prune does not count held edits as protected.
func TestThePruneKeepsAHeldEdit(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 1)
	be.dbx.edit(be.versionFile(ds[0]), []byte("edited bytes"))
	be.notice()
	open := be.open()
	require.Len(t, open, 1)
	cfg := &config.Config{}
	cfg.UseCoralDir(be.h.dbx.dataDir)
	sh := &SessionsHandler{db: be.db, cfg: cfg}
	kept, err := sh.protectedArtifacts(context.Background())
	require.NoError(t, err)
	assert.True(t, kept[open[0].Digest], "the held bytes are protected")
	ok, err := sh.isProtected(context.Background(), open[0].Digest)
	require.NoError(t, err)
	assert.True(t, ok, "and the re-check under the lock agrees")
}

// Security's SHOULD 7 on 085c4511b. Mutant: a passing fetch error is counted as skipped and the cursor moves on (the edit is missed).
func TestAFetchThatFailsOnceIsTriedAgain(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 2)
	be.dbx.edit(be.versionFile(ds[0]), []byte("edited while Dropbox had trouble"))
	be.dbx.failDownloads = 1
	be.notice()
	assert.Empty(t, be.open(), "nothing held: the download failed")
	be.notice()
	open := be.open()
	require.Len(t, open, 1, "the next pass fetches it")
	b, _ := os.ReadFile(be.objectPath(open[0].Digest))
	assert.Equal(t, "edited while Dropbox had trouble", string(b))
}
