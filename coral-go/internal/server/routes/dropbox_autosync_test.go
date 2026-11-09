package routes

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// #14714, auto-sync of edits made in Dropbox (the Operator's #196912), under Security Reviewer's conditions 1 to 9. Each test names its mutant.

// syncEnv backs up two artifacts of a team, ready for an edit in Dropbox.
func syncEnv(t *testing.T) (*backupEnv, []string) {
	t.Helper()
	be, ds := newDropboxEditEnv(t, 2)
	giveRecordsATeam(t, be.h.dbx.dataDir, "team-a")
	return be, ds
}

func (be *backupEnv) recordOf(digest string) (agentUploadRecord, bool) {
	var got agentUploadRecord
	found := false
	forEachUploadRecord(be.h.dbx.dataDir, func(_, d string, r agentUploadRecord) bool {
		if d == digest {
			got, found = r, true
		}
		return !found
	})
	return got, found
}

// Conditions 1 and 2. Mutants: the edit not promoted on its own; the record naming the Operator or the original uploader as the writer.
func TestAnEditMadeInDropboxBecomesTheNextVersionOnItsOwn(t *testing.T) {
	be, ds := syncEnv(t)
	be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited in Dropbox\n"))
	be.notice()
	assert.Empty(t, be.open(), "no edit waits: it is the next version")
	var e store.DropboxEdit
	require.NoError(t, be.db.Get(&e, "SELECT id, account_id, doc_id, version, orig_digest, path, digest, media_type, size, rev, state, seen_at FROM dropbox_edits LIMIT 1"))
	assert.Equal(t, store.DropboxEditPromoted, e.State)
	rec, ok := be.recordOf(e.Digest)
	require.True(t, ok, "the new version has its record")
	assert.Equal(t, dropboxEditUploader, rec.Uploader)
	assert.Equal(t, "dropbox", rec.UploadedBy, "never the owner")
	assert.Equal(t, "auto_sync", rec.PromotedBy, "never the Operator")
	assert.Equal(t, sourceDropboxEdit, rec.Source)
	assert.Equal(t, 2, rec.Version)
	a, _ := be.h.dbx.store.Audits(context.Background(), 1)
	require.Len(t, a, 1)
	assert.Equal(t, "dropbox", a[0].Who)
	assert.Equal(t, "auto_promoted", a[0].Reason)
}

// Condition 6. Mutant: the switch not read (an edit promoted while it is off, or while paused).
func TestTheSwitchOffOrAPauseHoldsTheEdit(t *testing.T) {
	ctx := context.Background()
	for _, set := range []func(*backupEnv) error{
		func(be *backupEnv) error { return be.h.dbx.store.SetAutoSync(ctx, false) },
		func(be *backupEnv) error { return be.h.dbx.store.PauseAutoSync(ctx, store.AutoSyncPausedSignIn) },
	} {
		be, ds := syncEnv(t)
		require.NoError(t, set(be))
		be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited\n"))
		be.notice()
		require.Len(t, be.open(), 1, "held for the Operator")
	}
}

// Condition 4. Mutants: a changed type or a big size jump promoted.
func TestAnAnomalyIsHeldForTheOperator(t *testing.T) {
	be, ds := syncEnv(t)
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	be.dbx.edit(be.versionFile(ds[0]), png) // a .md that became an image
	be.notice()
	require.Len(t, be.open(), 1, "a changed type waits for the Operator")
	e := store.DropboxEdit{MediaType: "text/markdown", Size: 20 << 20}
	assert.Equal(t, "size_jump", autoSyncAnomaly("text/markdown", 100, e))
	assert.Equal(t, "", autoSyncAnomaly("text/markdown", 100, store.DropboxEdit{MediaType: "text/markdown", Size: 900 << 10}), "under 1 MiB is no jump")
	assert.Equal(t, "", autoSyncAnomaly("text/markdown", 10<<20, store.DropboxEdit{MediaType: "text/markdown", Size: 20 << 20}), "twice the size is no jump")
	assert.Equal(t, "type_changed", autoSyncAnomaly("text/markdown", 10, store.DropboxEdit{MediaType: "image/png", Size: 10}))
}

// Condition 5. Mutants: the breaker off; only the hour's total counted (one document's flood not caught).
func TestTheBreakerPausesAutoSync(t *testing.T) {
	for name, c := range map[string]struct {
		n       int
		sameDoc bool
	}{"10 in an hour": {store.AutoSyncMaxPerHour, false}, "5 of one document": {store.AutoSyncMaxDocPerHour, true}} {
		t.Run(name, func(t *testing.T) {
			be, ds := syncEnv(t)
			rec, ok := be.recordOf(ds[0])
			require.True(t, ok)
			now := time.Now().UTC().Format(store.ISOFormat)
			for i := 0; i < c.n; i++ {
				doc := strings.Repeat("f", 31) + string(rune('a'+i%6))
				if c.sameDoc {
					doc = docIDOf(rec)
				}
				_, err := be.db.Exec(`INSERT INTO dropbox_edits (account_id, doc_id, version, orig_digest, path, digest, media_type, size, rev, state, seen_at, decided_at)
					VALUES ('x', ?, 1, 'o', 'p', ?, 'text/plain', 1, ?, 'promoted', ?, ?)`, doc, strings.Repeat("e", 63)+string(rune('a'+i%6)), "r"+string(rune('a'+i)), now, now)
				require.NoError(t, err)
			}
			be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited again\n"))
			be.notice()
			require.Len(t, be.open(), 1, "the edit is held")
			on, paused, err := be.h.dbx.store.AutoSync(context.Background())
			require.NoError(t, err)
			assert.True(t, on)
			assert.Equal(t, store.AutoSyncPausedBreaker, paused)
		})
	}
}

// Condition 6. Mutants: the route open to an agent or through the Hub; turning it on not resuming a pause.
func TestTheAutoSyncSwitchIsTheOperatorsAndResumes(t *testing.T) {
	be, _ := syncEnv(t)
	ctx := context.Background()
	require.NoError(t, be.h.dbx.store.PauseAutoSync(ctx, store.AutoSyncPausedBreaker))
	call := func(body string, dashboard bool) int {
		req := httptest.NewRequest(http.MethodPut, "/api/dropbox/autosync", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if dashboard {
			dashboardRequest(req)
			req.Host = be.host
		}
		rec := httptest.NewRecorder()
		be.h.DropboxSetAutoSync(rec, req)
		return rec.Code
	}
	assert.NotEqual(t, http.StatusOK, call(`{"on": true}`, false))
	assert.Equal(t, http.StatusBadRequest, call(`{}`, true))
	require.Equal(t, http.StatusOK, call(`{"on": true}`, true))
	on, paused, _ := be.h.dbx.store.AutoSync(ctx)
	assert.True(t, on)
	assert.Empty(t, paused, "Resume")
	require.Equal(t, http.StatusOK, call(`{"on": false}`, true))
	on, _, _ = be.h.dbx.store.AutoSync(ctx)
	assert.False(t, on)
}

// Security's SHOULD 4 on 5d1b9457e (condition 2). Mutant: the promote path copying the approved version's review, tags or star onto the edit.
func TestApprovalDoesNotCarryToAnEditFromDropbox(t *testing.T) {
	be, ds := syncEnv(t)
	ctx := context.Background()
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	require.NoError(t, bs.SetArtifactTags(ctx, "team-a", ds[0], []string{"for review"}))
	_, _, err = bs.DecideArtifactReview(ctx, "team-a", ds[0], board.ReviewApproved, time.Now())
	require.NoError(t, err)
	_, err = be.db.Exec("INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)", ds[0], time.Now().UTC().Format(time.RFC3339))
	require.NoError(t, err)
	be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited in Dropbox\n"))
	be.notice()
	var v2 string
	require.NoError(t, be.db.Get(&v2, "SELECT digest FROM dropbox_edits WHERE state = 'promoted'"))
	reviews, err := bs.ArtifactReviews(ctx, "team-a")
	require.NoError(t, err)
	_, approved := reviews[ds[0]]
	require.True(t, approved, "version 1 is approved")
	_, carried := reviews[v2]
	assert.False(t, carried, "version 2 (the edit) has no review: it needs one of its own")
	tags, err := bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Empty(t, tags[v2], "no tag carries")
	var stars int
	require.NoError(t, be.db.Get(&stars, "SELECT COUNT(*) FROM artifact_stars WHERE hex = ?", v2))
	assert.Zero(t, stars, "no star carries")
	rec, ok := be.recordOf(v2)
	require.True(t, ok)
	assert.Zero(t, rec.TaskID, "no task carries")
}

func (be *backupEnv) undoCall(digest string, dashboard bool) int {
	be.t.Helper()
	r := chi.NewRouter()
	r.Post("/api/dropbox/undo/{digest}", be.h.DropboxUndoEdit)
	req := httptest.NewRequest(http.MethodPost, "/api/dropbox/undo/"+digest, strings.NewReader(`{"confirm": true}`))
	req.Header.Set("Content-Type", "application/json")
	if dashboard {
		dashboardRequest(req)
		req.Host = be.host
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)) // a person at the dashboard (humanInputCaller)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec.Code
}

// Security's conditions 1 to 5 on Undo this edit. Mutants: the undo through the Operator's delete (a Dropbox removal queued); a version that is not
// the newest undone; the same revision taken again after the undo; the bytes removed while another record uses them; the numbering after it wrong.
func TestUndoThisEdit(t *testing.T) {
	be, ds := syncEnv(t)
	ctx := context.Background()
	be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited in Dropbox\n"))
	be.notice()
	var v2 string
	require.NoError(t, be.db.Get(&v2, "SELECT digest FROM dropbox_edits WHERE state = 'promoted'"))
	be.pass() // the new version is backed up as v2
	files := len(be.dbx.files)

	_, err := be.db.Exec(`INSERT INTO dropbox_outbox (kind, digest, doc_id, version, path, artifact_at, state, created_at) VALUES ('version', ?, ?, 1, '/v1/fff/other/v1-x.md', '2026-01-01T00:00:00Z', 'done', '2026-01-01T00:00:00Z')`,
		v2, strings.Repeat("f", 32)) // another document holding the same bytes (Security's SHOULD 5 on b11590071)
	require.NoError(t, err)
	assert.NotEqual(t, http.StatusOK, be.undoCall(v2, false), "the Operator's, on this computer only")
	assert.Equal(t, http.StatusConflict, be.undoCall(ds[0], true), "version 1 is not the newest")
	require.Equal(t, http.StatusOK, be.undoCall(v2, true))

	sid, _, ok := digestSeries(be.h.dbx.dataDir, ds[0])
	require.True(t, ok)
	ms := seriesMembers(be.h.dbx.dataDir, sid)
	require.Len(t, ms, 1, "the version before is the newest again")
	assert.Equal(t, ds[0], ms[0].Digest)
	_, err = os.Stat(be.objectPath(v2))
	assert.True(t, os.IsNotExist(err), "no other record uses the bytes: they go")
	assert.Equal(t, files, len(be.dbx.files), "nothing is removed from Dropbox: its history keeps the edit")
	var queued int
	require.NoError(t, be.db.Get(&queued, "SELECT COUNT(*) FROM dropbox_removals"))
	assert.Zero(t, queued, "no Dropbox removal is queued")
	var rows int
	require.NoError(t, be.db.Get(&rows, "SELECT COUNT(*) FROM dropbox_outbox WHERE digest = ? AND doc_id <> ?", v2, strings.Repeat("f", 32)))
	assert.Zero(t, rows, "the outbox forgets this version: never sent again")
	require.NoError(t, be.db.Get(&rows, "SELECT COUNT(*) FROM dropbox_outbox WHERE digest = ? AND doc_id = ?", v2, strings.Repeat("f", 32)))
	assert.Equal(t, 1, rows, "another document's rows of the same bytes stay")
	var state string
	require.NoError(t, be.db.Get(&state, "SELECT state FROM dropbox_edits WHERE digest = ?", v2))
	assert.Equal(t, store.DropboxEditUndone, state)

	downloads := len(be.dbx.downloads)
	be.notice()
	assert.Equal(t, downloads, len(be.dbx.downloads), "the undone revision is never taken again")
	assert.Equal(t, http.StatusNotFound, be.undoCall(v2, true), "gone: nothing to undo")

	// A new revision of the file is a new edit, and becomes the next number with a consistent list.
	be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited again in Dropbox\n"))
	be.notice()
	ms = seriesMembers(be.h.dbx.dataDir, sid)
	require.Len(t, ms, 2)
	assert.Equal(t, 1, ms[0].N)
	assert.Equal(t, 2, ms[1].N, "the next number after the undo")
	assert.NotEqual(t, v2, ms[1].Digest)
	_ = ctx
}

// pngWithText is a 1x1 PNG carrying a tEXt chunk (metadata the upload route strips).
func pngWithText(t *testing.T, note string) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewGray(image.Rect(0, 0, 1, 1))))
	b := buf.Bytes()
	data := append([]byte("Comment\x00"), note...)
	chunk := make([]byte, 0, 12+len(data))
	chunk = binary.BigEndian.AppendUint32(chunk, uint32(len(data)))
	typed := append([]byte("tEXt"), data...)
	chunk = append(chunk, typed...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(typed))
	at := 8 + 25 // after the signature and IHDR
	return append(append(append([]byte{}, b[:at]...), chunk...), b[at:]...)
}

// Security's SHOULD 3 on 5d1b9457e. Mutants: the hourly cap or the image metadata rule not applied to a promotion.
func TestAPromotionPassesTheUploadChecks(t *testing.T) {
	t.Run("the hourly cap", func(t *testing.T) {
		be, ds := syncEnv(t)
		st := storeFor(be.h.dbx.dataDir)
		for st.chargeUpload(autoSyncBucket, uploadWindowBytes) {
		}
		be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited\n"))
		be.notice()
		require.Len(t, be.open(), 1, "over auto-sync's hourly cap: held")
	})
	t.Run("an image with metadata", func(t *testing.T) {
		be := newBackupEnv(t)
		d := be.put("pic.png", "image/png", string(pngWithText(t, "clean")))
		be.pass()
		be.b.Notice(context.Background())
		giveRecordsATeam(t, be.h.dbx.dataDir, "team-a")
		be.dbx.edit(be.versionFile(d), pngWithText(t, "taken at home, 51.5N 0.1W"))
		be.notice()
		require.Len(t, be.open(), 1, "an image whose metadata the upload route would strip is held, never rewritten on its own")
	})
}
