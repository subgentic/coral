package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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
