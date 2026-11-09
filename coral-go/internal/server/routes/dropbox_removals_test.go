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

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// #14814 reworked: deleting a file in Coral deletes its Dropbox copy too, under Security Reviewer's conditions 1 to 4. Each test names the mutant
// it fails against.

// sessions is a SessionsHandler on the same data folder and database, for the Operator's delete routes.
func (be *backupEnv) sessions() *SessionsHandler {
	cfg := &config.Config{LogDir: be.t.TempDir()}
	cfg.UseCoralDir(be.h.dbx.dataDir)
	return NewSessionsHandler(be.db, cfg, nil, newMockTerminal(), nil)
}

// operatorDelete deletes an artifact through DELETE /api/artifacts/{id}, from the dashboard (operator) or as an agent's token.
func (be *backupEnv) operatorDelete(digest string, operator bool) int {
	be.t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/artifacts/"+digest, nil)
	if operator {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", digest)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	be.sessions().deleteAgentArtifact(rec, req)
	return rec.Code
}

// due makes every waiting removal due now (the grace passed).
func (be *backupEnv) due() {
	be.t.Helper()
	_, err := be.db.Exec("UPDATE dropbox_removals SET due_at = ?, next_try_at = ''", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339))
	require.NoError(be.t, err)
}

func (be *backupEnv) removal(d string) (store.DropboxRemoval, bool) {
	be.t.Helper()
	r, ok, err := be.b.outbox.Removal(context.Background(), d)
	require.NoError(be.t, err)
	return r, ok
}

func (be *backupEnv) removalsCall(method, path, body string, dashboard bool) (int, map[string]any) {
	be.t.Helper()
	r := chi.NewRouter()
	r.Get("/api/dropbox/removals", be.h.DropboxRemovals)
	r.Post("/api/dropbox/removals/cancel", be.h.DropboxCancelRemovals)
	r.Post("/api/dropbox/removals/confirm", be.h.DropboxConfirmRemovals)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
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

// Conditions 2 and 4, and SHOULD 6 on 26b4d8235. Mutants: no grace (removed at once); the removal not run once due; the removed rows kept after
// a delete-driven removal (a later upload of the same bytes would silently not be backed up); no audit row.
func TestTheOperatorsDeleteRemovesTheDropboxCopyAfterTheGrace(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	require.Equal(t, http.StatusOK, be.operatorDelete(ds[0], true))
	r, ok := be.removal(ds[0])
	require.True(t, ok, "the Operator's delete queues the removal")
	assert.Equal(t, store.DropboxRemovalWaiting, r.State)
	assert.Equal(t, "r0.md", r.Name, "named for Settings by the file's name at the delete")
	be.b.Removals(context.Background())
	assert.Equal(t, 2, be.inDropbox(ds[0]), "nothing goes before the 24-hour grace")
	be.due()
	be.b.Removals(context.Background())
	assert.Zero(t, be.inDropbox(ds[0]), "the version and its sidecar are removed once due")
	_, ok = be.removal(ds[0])
	assert.False(t, ok, "a finished removal leaves no row")
	removed, err := be.b.outbox.WasRemoved(context.Background(), ds[0])
	require.NoError(t, err)
	assert.False(t, removed, "a delete is not a decision to keep the bytes out (Security's SHOULD 6)")
	again := be.put("r0 later.md", "text/markdown", "# removal 0\n") // the same bytes, uploaded after the removal ran
	require.Equal(t, ds[0], again)
	be.pass()
	assert.Equal(t, 2, be.inDropbox(ds[0]), "a later upload of the same bytes is backed up as usual")
	a, _ := be.h.dbx.store.Audits(context.Background(), 1)
	require.Len(t, a, 1)
	assert.Equal(t, "deleted_here", a[0].Reason)
	assert.Equal(t, 2, a[0].Count)
	assert.Empty(t, a[0].Who, "the job, not a person, made it")
}

// Condition 1. Mutants: the hook in deleteArtifactFiles (every delete path) instead of the Operator's routes; an agent's delete queuing one.
func TestOnlyTheOperatorsOwnDeleteQueuesARemoval(t *testing.T) {
	be, ds := newRemovalEnv(t, 3)
	assert.Equal(t, http.StatusForbidden, be.operatorDelete(ds[0], false), "an agent's token cannot delete")
	_, ok := be.removal(ds[0])
	assert.False(t, ok)
	// The prune, unlisted cleanup and shared images all delete through deleteArtifactFiles / deleteArtifactFilesLocked.
	_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, ds[1])
	require.NoError(t, err)
	func() {
		defer lockArtifact(ds[2])()
		_, _, _, err = deleteArtifactFilesLocked(be.h.dbx.dataDir, ds[2])
	}()
	require.NoError(t, err)
	be.due()
	be.b.Removals(context.Background())
	for _, d := range ds {
		_, ok := be.removal(d)
		assert.False(t, ok, "no removal for %s", d[:8])
		assert.Equal(t, 2, be.inDropbox(d), "every automatic delete keeps the Dropbox copy")
	}
}

// Condition 2. Mutants: an upload of the same bytes not cancelling it; the object being here again at the due time not checked.
func TestTheSameBytesAgainCancelTheRemoval(t *testing.T) {
	be, ds := newRemovalEnv(t, 2)
	require.Equal(t, http.StatusOK, be.operatorDelete(ds[0], true))
	require.Equal(t, http.StatusOK, be.operatorDelete(ds[1], true))
	again := be.put("r0 again.md", "text/markdown", "# removal 0\n")
	require.Equal(t, ds[0], again)
	_, ok := be.removal(ds[0])
	assert.False(t, ok, "an upload of the same bytes cancels the removal")
	require.NoError(t, os.WriteFile(be.objectPath(ds[1]), []byte("# removal 1\n"), 0o600)) // restored by hand, no upload record
	be.due()
	be.b.Removals(context.Background())
	assert.Equal(t, 2, be.inDropbox(ds[1]), "the bytes are here again: nothing is removed")
	_, ok = be.removal(ds[1])
	assert.False(t, ok)
}

// Condition 4. Mutants: another Coral's marker or an unreadable listing removing anyway (or retried forever instead of listed); an edited file forced.
func TestAnythingSixAWouldAskAboutIsListedNotRemoved(t *testing.T) {
	be, ds := newRemovalEnv(t, 3)
	be.marker(ds[0], strings.Repeat("3", 28)+"c0de")
	p := be.versionFile(ds[1])
	be.dbx.revs = map[string]string{p: "r2"}
	for _, d := range ds {
		require.Equal(t, http.StatusOK, be.operatorDelete(d, true))
	}
	be.dbx.markersFail = false
	be.due()
	// ds[2]'s marker listing fails: do it in its own pass.
	_, _ = be.db.Exec("UPDATE dropbox_removals SET due_at = '9999' WHERE digest = ?", ds[2])
	be.b.Removals(context.Background())
	r0, _ := be.removal(ds[0])
	assert.Equal(t, store.DropboxRemovalKept, r0.State)
	assert.Equal(t, []string{"c0de"}, r0.OthersList())
	assert.Equal(t, 2, be.inDropbox(ds[0]), "another Coral keeps it only in Dropbox: left alone")
	r1, _ := be.removal(ds[1])
	assert.Equal(t, store.DropboxRemovalEdited, r1.State)
	assert.Contains(t, be.dbx.files, p, "the edited file is not forced")
	be.dbx.markersFail = true
	be.due()
	be.b.Removals(context.Background())
	r2, _ := be.removal(ds[2])
	assert.Equal(t, store.DropboxRemovalKept, r2.State)
	assert.Equal(t, "markers_unreadable", r2.Reason)
	assert.Equal(t, 2, be.inDropbox(ds[2]))
	be.dbx.markersFail = false

	// Settings lists them, and the Operator's own controls finish them: the typed confirm, and Remove anyway at the rev shown.
	code, out := be.removalsCall(http.MethodGet, "/api/dropbox/removals", "", true)
	require.Equal(t, http.StatusOK, code)
	rows, _ := out["removals"].([]any)
	require.Len(t, rows, 3)
	code, _ = be.removeCall("remove", ds[0], `{"confirm": true, "typed": ["c0de"]}`, true)
	require.Equal(t, http.StatusOK, code)
	_, ok := be.removal(ds[0])
	assert.False(t, ok, "removed from Settings: the row goes")
	code, _ = be.removeCall("remove", ds[1], fmt.Sprintf(`{"confirm": true, "anyway": {%q: "r2"}}`, p), true)
	require.Equal(t, http.StatusOK, code)
	assert.Zero(t, be.inDropbox(ds[1]))
	_, ok = be.removal(ds[1])
	assert.False(t, ok)
}

// Condition 3. Mutants: a series delete of many versions not held; Confirm not letting them go; Keep them in Dropbox removing anything.
func TestABulkDeleteIsHeldForTheOperator(t *testing.T) {
	be, ds := newRemovalEnv(t, 2)
	ctx := context.Background()
	for _, d := range ds {
		_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, d) // gone here (a delete path that queues nothing itself)
		require.NoError(t, err)
		_, err = be.b.outbox.QueueRemoval(ctx, d, "f", time.Now(), true)
		require.NoError(t, err)
	}
	be.due()
	be.b.Removals(ctx)
	assert.Equal(t, 2, be.inDropbox(ds[0]), "held: nothing goes on its own")
	code, _ := be.removalsCall(http.MethodPost, "/api/dropbox/removals/confirm", `{"confirm": true}`, false)
	assert.NotEqual(t, http.StatusOK, code, "only the Operator, on this computer")
	code, _ = be.removalsCall(http.MethodPost, "/api/dropbox/removals/confirm", `{}`, true)
	assert.Equal(t, http.StatusBadRequest, code, "the confirm is needed")
	code, _ = be.removalsCall(http.MethodPost, "/api/dropbox/removals/cancel", fmt.Sprintf(`{"digest": %q}`, ds[1]), false)
	assert.NotEqual(t, http.StatusOK, code, "Keep in Dropbox is the Operator's, on this computer (QA's survivor a)")
	_, ok := be.removal(ds[1])
	require.True(t, ok, "nothing was cancelled")
	code, _ = be.removalsCall(http.MethodPost, "/api/dropbox/removals/cancel", fmt.Sprintf(`{"digest": %q}`, ds[1]), true)
	require.Equal(t, http.StatusOK, code)
	code, out := be.removalsCall(http.MethodPost, "/api/dropbox/removals/confirm", `{"confirm": true}`, true)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, out["confirmed"])
	be.due()
	be.b.Removals(ctx)
	assert.Zero(t, be.inDropbox(ds[0]), "confirmed: removed")
	assert.Equal(t, 2, be.inDropbox(ds[1]), "kept in Dropbox by the Operator")
	code, _ = be.removalsCall(http.MethodPost, "/api/dropbox/removals/cancel", `{"state": "kept"}`, true)
	assert.Equal(t, http.StatusBadRequest, code, "kept and edited rows are ended one by one, from their own controls")
	code, _ = be.removalsCall(http.MethodGet, "/api/dropbox/removals", "", false)
	assert.NotEqual(t, http.StatusOK, code)
}

// Condition 3, a series. Mutant: a series delete of more than 10 versions not bulk (or every series delete bulk).
func TestASeriesDeleteOfManyVersionsIsBulk(t *testing.T) {
	assert.False(t, seriesDeleteIsBulk(1))
	assert.False(t, seriesDeleteIsBulk(dropboxSeriesBulk))
	assert.True(t, seriesDeleteIsBulk(dropboxSeriesBulk+1))
}

// Condition 2. Mutant: a delete job still running reported as removed (the row dropped before Dropbox's per-entry answer).
func TestARunningDeleteJobIsTriedAgainNotReportedDone(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	be.b.retainWait = time.Millisecond // stop following the job at once
	be.dbx.asyncPolls = 1000
	require.Equal(t, http.StatusOK, be.operatorDelete(ds[0], true))
	be.due()
	be.b.Removals(context.Background())
	r, ok := be.removal(ds[0])
	require.True(t, ok, "still waiting: Dropbox has not said each file went")
	assert.Equal(t, store.DropboxRemovalWaiting, r.State)
	assert.Equal(t, 1, r.Attempts)
	assert.NotEmpty(t, r.NextTryAt)
	assert.Equal(t, 10*time.Minute, removalBackoff(0))
	assert.Equal(t, 40*time.Minute, removalBackoff(2), "the wait doubles")
	assert.Equal(t, 6*time.Hour, removalBackoff(20), "up to 6 hours")
}

// Security's INFO on 5690c313f. Mutant: the job forgets the removed rows when it removed nothing itself (an explicit Remove from Dropbox made
// before the job ran would lose its "stays out until sent again").
func TestAnExplicitRemoveBeforeTheJobKeepsItsStaysOutRule(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	ctx := context.Background()
	code, _ := be.removeCall("remove", ds[0], `{"confirm": true}`, true) // the Operator's explicit Remove from Dropbox
	require.Equal(t, http.StatusOK, code)
	_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, ds[0])
	require.NoError(t, err)
	_, err = be.b.outbox.QueueRemoval(ctx, ds[0], "r0.md", time.Now(), false) // a removal queued anyway (an earlier delete of the same bytes)
	require.NoError(t, err)
	be.due()
	be.b.Removals(ctx)
	removed, err := be.b.outbox.WasRemoved(ctx, ds[0])
	require.NoError(t, err)
	assert.True(t, removed, "the explicit removal still keeps the bytes out until Send to Dropbox again")
}

// QA's survivor (b) on #14814. Mutant: a try that Dropbox failed is dropped instead of retried (the RetryRemoval call removed).
func TestAFailedRemovalTryIsRetriedNotDropped(t *testing.T) {
	be, ds := newRemovalEnv(t, 1)
	require.Equal(t, http.StatusOK, be.operatorDelete(ds[0], true))
	be.due()
	be.dbx.failDeletes = 1
	be.b.Removals(context.Background())
	r, ok := be.removal(ds[0])
	require.True(t, ok, "still queued after Dropbox failed the delete")
	assert.Equal(t, store.DropboxRemovalWaiting, r.State)
	assert.Equal(t, 1, r.Attempts)
	assert.Equal(t, 2, be.inDropbox(ds[0]), "nothing removed yet")
	be.due()
	be.b.Removals(context.Background())
	assert.Zero(t, be.inDropbox(ds[0]), "removed on the next try")
	_, ok = be.removal(ds[0])
	assert.False(t, ok)
}
