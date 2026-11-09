package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14814, Dropbox stage 6a: explicit removal, against the fake Dropbox. Each test names the mutant it fails against (Security's 2a to 2g).

func newRemovalEnv(t *testing.T, n int) (*backupEnv, []string) {
	t.Helper()
	be := newBackupEnv(t)
	be.b.retainPoll, be.b.retainWait = time.Millisecond, 50*time.Millisecond
	var ds []string
	for i := 0; i < n; i++ {
		ds = append(ds, be.put(fmt.Sprintf("r%d.md", i), "text/markdown", fmt.Sprintf("# removal %d\n", i)))
	}
	be.pass()
	require.Len(t, be.dbx.files, 2*n)
	return be, ds
}

// removeCall posts a removal route through a chi router (the {digest} parameter), from this computer's dashboard or not.
func (be *backupEnv) removeCall(action, digest, body string, dashboard bool) (int, map[string]any) {
	be.t.Helper()
	r := chi.NewRouter()
	r.Post("/api/dropbox/remove/{digest}", be.h.DropboxRemove)
	r.Post("/api/dropbox/resend/{digest}", be.h.DropboxResend)
	req := httptest.NewRequest(http.MethodPost, "/api/dropbox/"+action+"/"+digest, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if dashboard {
		dashboardRequest(req)
		req.Host = be.host
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return rec.Code, m
}

func (be *backupEnv) marker(digest, server string) {
	be.dbx.mu.Lock()
	be.dbx.files["/v1/offloaded/"+digest[:3]+"/"+digest+"/"+server] = nil
	be.dbx.mu.Unlock()
}

// Mutants: a removal without confirm acts; the local copy is touched; a removed artifact is sent again by a later upload or the backfill.
func TestRemoveTakesTheArtifactOutOfDropboxForGood(t *testing.T) {
	be, ds := newRemovalEnv(t, 2)
	code, _ := be.removeCall("remove", ds[0], `{}`, true)
	assert.Equal(t, http.StatusBadRequest, code, "the confirm is required")
	assert.Equal(t, 2, be.inDropbox(ds[0]))
	code, out := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, out["removed"], "the version and its sidecar")
	assert.Zero(t, be.inDropbox(ds[0]))
	assert.Equal(t, 2, be.inDropbox(ds[1]), "another artifact is untouched")
	_, err := os.Stat(be.objectPath(ds[0]))
	assert.NoError(t, err, "the local copy is never touched")
	assert.Equal(t, 2, be.counts().Removed)
	// The same bytes uploaded again, by another session: not sent (Security's 2d).
	_, _, err = storeArtifactVia(be.h.dbx.dataDir, "sess-2", "again.md", "text/markdown", "", "", "", []byte("# removal 0\n"))
	require.NoError(t, err)
	be.b.Backfill(context.Background())
	be.pass()
	assert.Zero(t, be.inDropbox(ds[0]), "never sent again")
	a, _ := be.h.dbx.store.Audits(context.Background(), 3)
	require.NotEmpty(t, a)
	assert.Equal(t, store.DropboxAudit{At: a[0].At, Kind: "removal", Who: "operator", Count: 2, Reason: "removed"}, a[0])
}

// Mutant: the routes take a request from outside the dashboard, or an id that is not 64 hex.
func TestTheRemovalRoutesAreTheOperatorsOnThisComputer(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	for _, action := range []string{"remove", "resend"} {
		code, _ := be.removeCall(action, ds[0], `{"confirm": true}`, false)
		assert.NotEqual(t, http.StatusOK, code, action)
	}
	code, _ := be.removeCall("remove", strings.ToUpper(ds[0]), `{"confirm": true}`, true)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, 2, be.inDropbox(ds[0]))
}

// Security's 1a and 2a. Mutants: another Coral's marker is ignored; the typed check takes the page's word, or one of several; an unknown marker
// name passes.
func TestAnotherCoralsMarkerNeedsItsLastFourTyped(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	a, b := strings.Repeat("1", 28)+"a3f2", strings.Repeat("2", 28)+"bb07"
	be.marker(ds[0], a)
	be.marker(ds[0], b)
	code, out := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "others_offloaded", out["code"])
	assert.ElementsMatch(t, []any{"a3f2", "bb07"}, out["others"])
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["a3f2"]}`, true)
	assert.Equal(t, http.StatusConflict, code, "one of two is not enough")
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["a3f2", "bb0"]}`, true)
	assert.Equal(t, http.StatusConflict, code, "compared exactly")
	assert.Equal(t, 2, be.inDropbox(ds[0]), "nothing removed so far")
	be.marker(ds[0], "not-an-id")
	code, out = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["a3f2", "bb07"]}`, true)
	assert.Equal(t, http.StatusConflict, code, "an unknown marker name is covered only by typing unknown")
	assert.EqualValues(t, 1, out["unknown"])
	code, out = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["a3f2", "bb07", "unknown"]}`, true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Zero(t, be.inDropbox(ds[0]))
}

// Security's 2a. Mutant: a failed marker listing is read as "no markers".
func TestAnUnreadableMarkerListingRemovesNothing(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	be.dbx.markersFail = true
	code, out := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.Equal(t, "markers_unreadable", out["code"])
	assert.Equal(t, 2, be.inDropbox(ds[0]))
}

// Security's 2c. Mutants: a delete without the ledger rev; Remove anyway deletes whatever is there.
func TestAFileEditedInDropboxIsReportedAndRemoveAnywayUsesTheShownRev(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	p := be.versionFile(ds[0])
	be.dbx.revs = map[string]string{p: "r2"}
	code, out := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	edited, _ := out["edited"].([]any)
	require.Len(t, edited, 1, "the edited version is reported, the sidecar removed")
	e0 := edited[0].(map[string]any)
	assert.Equal(t, p, e0["path"])
	assert.Equal(t, "r2", e0["rev"], "the rev Dropbox has now")
	assert.Contains(t, be.dbx.files, p, "the edit is kept")
	be.dbx.revs[p] = "r3" // changed again after the dialog showed r2
	code, _ = be.removeCall("remove", ds[0], fmt.Sprintf(`{"confirm": true, "anyway": {%q: "r2"}}`, p), true)
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, be.dbx.files, p, "a second change is refused again")
	code, _ = be.removeCall("remove", ds[0], fmt.Sprintf(`{"confirm": true, "anyway": {%q: "r3"}}`, p), true)
	require.Equal(t, http.StatusOK, code)
	assert.NotContains(t, be.dbx.files, p, "deleted at the shown rev")
}

// Security's 1b and 2b. Mutants: delete-all without the typed word or the foreign count; the sign-in forgotten before the delete finished.
func TestDeleteTheBackupNeedsItsTypedConfirmAndFinishesBeforeDisconnecting(t *testing.T) {
	be, _ := newRemovalEnv(t, 2)
	be.dbx.mu.Lock()
	be.dbx.files["/v1/aaa/someone-elses.md"] = []byte("x") // not this computer's backup
	be.dbx.mu.Unlock()
	disconnect := func(body string) (int, map[string]any) {
		be.body = body
		rec := be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
		var m map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		return rec.Code, m
	}
	code, out := disconnect(`{"delete_backup": true}`)
	require.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "confirm_delete_backup", out["code"])
	assert.EqualValues(t, 1, out["foreign"], "the file not from this computer is counted")
	code, _ = disconnect(`{"delete_backup": true, "typed": ["delete"]}`)
	assert.Equal(t, http.StatusConflict, code, "the foreign count must be typed too")
	assert.True(t, be.status()["connected"].(bool))

	be.dbx.asyncPolls = 1000 // Dropbox still deleting after the wait
	code, out = disconnect(`{"delete_backup": true, "typed": ["delete", "1"]}`)
	assert.Equal(t, http.StatusAccepted, code, "%v", out)
	assert.True(t, be.status()["connected"].(bool), "still connected: the delete did not finish")

	be.dbx.mu.Lock()
	be.dbx.asyncPolls = 0
	be.dbx.mu.Unlock()
	code, out = disconnect(`{"delete_backup": true, "typed": ["delete", "1"]}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	for p := range be.dbx.files {
		assert.False(t, strings.HasPrefix(p, "/v1/"), "the backup is gone: %s", p)
	}
	assert.False(t, be.status()["connected"].(bool), "then disconnected")
	assert.Zero(t, be.counts().BackedUp+be.counts().Removed, "the ledger is cleared, so a later sign-in backs everything up afresh")
}

// Disconnect without delete_backup is as it was (Security's 2g).
func TestPlainDisconnectIsUnchanged(t *testing.T) {
	be, _ := newRemovalEnv(t, 1)
	be.body = `{}`
	rec := be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Len(t, be.dbx.files, 2, "nothing deleted in Dropbox")
	assert.Equal(t, 2, be.counts().BackedUp, "the ledger kept")
}

// Security's SHOULD 4 on cb3ff32dd. Mutant: a listing cut off with more to read goes on to delete.
func TestDeleteAllRefusesAListingCutOff(t *testing.T) {
	be, _ := newRemovalEnv(t, 3) // 6 files
	old := dropboxListPagesMax
	dropboxListPagesMax = 1
	t.Cleanup(func() { dropboxListPagesMax = old })
	be.dbx.pageSize = 2 // three pages: the one allowed does not finish
	be.body = `{"delete_backup": true, "typed": ["delete"]}`
	rec := be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "listing_unreadable")
	assert.Len(t, be.dbx.files, 6, "nothing deleted")
	assert.True(t, be.status()["connected"].(bool))
}

// Security's SHOULD 5 on cb3ff32dd. Mutant: the queued rows go before the marker check (a refused removal has already changed the backup).
func TestARefusedRemovalLeavesWhatStillWaits(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	_, err := be.db.ExecContext(context.Background(), `INSERT INTO dropbox_outbox (kind, digest, doc_id, version, path, artifact_at, created_at) VALUES ('version', ?, ?, 2, '/v1/zzz/waiting.md', ?, ?)`,
		ds[0], strings.Repeat("e", 32), time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
	require.NoError(t, err)
	be.marker(ds[0], strings.Repeat("4", 28)+"beef")
	code, _ := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusConflict, code)
	row, err := be.b.outbox.ByPath(context.Background(), "/v1/zzz/waiting.md")
	require.NoError(t, err)
	assert.Equal(t, store.DropboxOutboxQueued, row.State, "still waiting: the refused removal changed nothing")
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["beef"]}`, true)
	require.Equal(t, http.StatusOK, code)
	row, _ = be.b.outbox.ByPath(context.Background(), "/v1/zzz/waiting.md")
	assert.Equal(t, store.DropboxOutboxRemoved, row.State, "once the removal goes ahead, it is not sent")
}

// Security's SHOULD 6 on cb3ff32dd. Mutants: resend leaves the removed rows (the artifact stays out); resend takes a request from outside the dashboard.
func TestSendToDropboxAgainPutsARemovedArtifactBack(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	code, _ := be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code)
	require.Zero(t, be.inDropbox(ds[0]))
	code, _ = be.removeCall("resend", ds[0], `{}`, false)
	assert.NotEqual(t, http.StatusOK, code, "not from outside the dashboard")
	code, out := be.removeCall("resend", ds[0], `{}`, true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["queued"])
	be.pass()
	assert.Equal(t, 2, be.inDropbox(ds[0]), "backed up again: the version and its sidecar")
	be.private[ds[0]] = true // a private mark still keeps it out after a resend
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code)
	_, _ = be.removeCall("resend", ds[0], `{}`, true)
	be.pass()
	assert.Zero(t, be.inDropbox(ds[0]), "marked private: not sent, resend or not")
}

// The Details block's read (#14814). Mutants: the state counts another account's rows, or misses the removed mark; the read is served outside the
// dashboard.
func TestTheArtifactStateSaysInDropboxThenRemoved(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	get := func(dashboard bool) (int, map[string]any) {
		r := chi.NewRouter()
		r.Get("/api/dropbox/artifact/{digest}", be.h.DropboxArtifact)
		req := httptest.NewRequest(http.MethodGet, "/api/dropbox/artifact/"+ds[0], nil)
		if dashboard {
			dashboardRequest(req)
			req.Host = be.host
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var m map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		return rec.Code, m
	}
	code, _ := get(false)
	assert.NotEqual(t, http.StatusOK, code, "not from outside the dashboard")
	code, out := get(true)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, map[string]any{"connected": true, "in_dropbox": float64(2), "removed": false, "undo": false, "kept_in_dropbox": false}, out)
	_, err := be.db.ExecContext(context.Background(), "UPDATE dropbox_outbox SET account_id = 'dbid:OLD' WHERE digest = ? AND kind = 'item_data'", ds[0])
	require.NoError(t, err)
	_, out = get(true)
	assert.EqualValues(t, 1, out["in_dropbox"], "only the connected account's files")
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code)
	_, out = get(true)
	assert.Equal(t, true, out["removed"])
	assert.EqualValues(t, 0, out["in_dropbox"])
}
