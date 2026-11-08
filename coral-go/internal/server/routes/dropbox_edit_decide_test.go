package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14714, Dropbox stage 5a piece 2: the Operator's decision on an edit made in Dropbox. Each test names the mutant it fails against.

// heldEdit backs up two artifacts, edits the first in Dropbox and holds the edit.
func heldEdit(t *testing.T) (*backupEnv, []string, store.DropboxEdit) {
	t.Helper()
	be, ds := newDropboxEditEnv(t, 2)
	giveRecordsATeam(t, be.h.dbx.dataDir, "team-a")
	be.dbx.edit(be.versionFile(ds[0]), []byte("# doc 0, edited in Dropbox\n"))
	be.notice()
	open := be.open()
	require.Len(t, open, 1)
	return be, ds, open[0]
}

// giveRecordsATeam stamps every upload record with a board (a test session is no agent's, so its records name none; a real upload names its team).
func giveRecordsATeam(t *testing.T, dir, board string) {
	t.Helper()
	forEachUploadRecord(dir, func(session, d string, rec agentUploadRecord) bool {
		rec.Board = board
		b, err := json.Marshal(rec)
		require.NoError(t, err)
		require.NoError(t, writeFileAtomic(filepath.Join(uploadsDir(dir, session), d+".json"), b, 0o600))
		return true
	})
}

// decide calls a decision route through a chi router (the {doc} parameter), from this computer's dashboard or not.
func (be *backupEnv) decide(doc, action string, dashboard bool) *httptest.ResponseRecorder {
	be.t.Helper()
	r := chi.NewRouter()
	r.Post("/api/dropbox/edits/{doc}/promote", be.h.DropboxPromoteEdit)
	r.Post("/api/dropbox/edits/{doc}/separate", be.h.DropboxSeparateEdit)
	req := httptest.NewRequest(http.MethodPost, "/api/dropbox/edits/"+doc+"/"+action, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	if dashboard {
		dashboardRequest(req)
		req.Host = be.host
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func decideAnswer(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &m), rec.Body.String())
	return m
}

// Mutants: Promote writes no record, the wrong uploader, or carries review/task state; the decision is not recorded.
func TestPromoteMakesTheNextVersionByTheUnknownWriter(t *testing.T) {
	be, _, e := heldEdit(t)
	rec := be.decide(e.DocID, "promote", true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	m := decideAnswer(t, rec)
	assert.Equal(t, "promoted", m["decision"])
	assert.EqualValues(t, 2, m["version"])
	require.True(t, be.hasRecord(e.Digest), "the edit has its record now")
	var got agentUploadRecord
	forEachUploadRecord(be.h.dbx.dataDir, func(_, d string, r agentUploadRecord) bool {
		if d == e.Digest {
			got = r
		}
		return true
	})
	assert.Equal(t, dropboxEditUploader, got.Uploader, "never the owner")
	assert.Equal(t, sourceDropboxEdit, got.Source)
	assert.Equal(t, "operator", got.PromotedBy)
	assert.Equal(t, 2, got.Version)
	assert.Equal(t, e.DocID, docIDOf(got), "the same document")
	assert.Zero(t, got.TaskID, "no task state carried")
	open, _ := be.b.edits.IsOpen(context.Background(), e.DocID)
	assert.False(t, open)
	a, _ := be.h.dbx.store.Audits(context.Background(), 5)
	require.NotEmpty(t, a)
	assert.Equal(t, store.DropboxAudit{At: a[0].At, Kind: "edit", Who: "operator", Reason: "promoted"}, a[0], "audited, with no names")
	be.pass()
	found := false
	for p := range be.dbx.files {
		if strings.Contains(p, "/v2-"+e.Digest[:8]) {
			found = true
		}
	}
	assert.True(t, found, "the new version is backed up as v2")
	_, err := os.Stat(be.objectPath(e.Digest))
	assert.NoError(t, err, "the bytes are in the store now")
	_, err = os.Stat(be.b.heldPath(e.Digest))
	assert.True(t, os.IsNotExist(err), "and the held copy is gone")
}

// Security's SHOULD E. Mutant: Promote loosens the series' own-uploader rule.
func TestAfterPromoteTheSeriesRuleStillRefusesAnotherUploader(t *testing.T) {
	be, _, e := heldEdit(t)
	require.Equal(t, http.StatusOK, be.decide(e.DocID, "promote", true).Code)
	id, _, ok := digestSeries(be.h.dbx.dataDir, e.Digest)
	require.True(t, ok)
	var board string
	forEachUploadRecord(be.h.dbx.dataDir, func(_, d string, r agentUploadRecord) bool {
		if d == e.Digest {
			board = r.Board
		}
		return true
	})
	plan, err := planNewVersion(be.h.dbx.dataDir, id, board, strings.Repeat("ab", 32))
	require.NoError(t, err)
	defer plan.unlock()
	plan.caller = "some-agent"
	_, stale := plan.staleBase()
	assert.True(t, stale, "a bare file id from another uploader is refused: the newest is the promoted edit")
}

// Mutant: Keep separate reuses the document id.
func TestKeepSeparateMakesItsOwnDocument(t *testing.T) {
	be, ds, e := heldEdit(t)
	rec := be.decide(e.DocID, "separate", true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	m := decideAnswer(t, rec)
	assert.Equal(t, "separate", m["decision"])
	nd, _ := m["doc_id"].(string)
	assert.Regexp(t, `^[0-9a-f]{32}$`, nd)
	assert.NotEqual(t, e.DocID, nd)
	var got agentUploadRecord
	forEachUploadRecord(be.h.dbx.dataDir, func(_, d string, r agentUploadRecord) bool {
		if d == e.Digest {
			got = r
		}
		return true
	})
	assert.Equal(t, "doc0 (edited in Dropbox).md", got.Name)
	assert.Equal(t, dropboxEditUploader, got.Uploader)
	assert.Empty(t, got.PromotedBy)
	assert.Zero(t, got.Version, "not in the original's series")
	_, _, inSeries := digestSeries(be.h.dbx.dataDir, ds[0])
	assert.False(t, inSeries, "the original is untouched")
}

// Security's SHOULD F. Mutants: a second decision is accepted; both buttons at once both win.
func TestAnEditIsDecidedOnce(t *testing.T) {
	be, _, e := heldEdit(t)
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, action := range []string{"promote", "separate"} {
		wg.Add(1)
		go func(i int, action string) { defer wg.Done(); codes[i] = be.decide(e.DocID, action, true).Code }(i, action)
	}
	wg.Wait()
	ok, conflict := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		}
	}
	assert.Equal(t, 1, ok, "%v", codes)
	assert.Equal(t, 1, conflict, "%v", codes)
	assert.Equal(t, http.StatusConflict, be.decide(e.DocID, "promote", true).Code, "and never again")
}

// Mutants: the routes take a request from outside the dashboard, or an id that is not 32 hex.
func TestTheDecisionRoutesAreTheOperatorsOnThisComputer(t *testing.T) {
	be, _, e := heldEdit(t)
	assert.NotEqual(t, http.StatusOK, be.decide(e.DocID, "promote", false).Code, "not from outside the dashboard")
	assert.Equal(t, http.StatusBadRequest, be.decide(strings.ToUpper(e.DocID), "promote", true).Code)
	assert.NotEqual(t, http.StatusOK, be.decide("../../etc", "promote", true).Code, "no route for it")
	open, _ := be.b.edits.IsOpen(context.Background(), e.DocID)
	assert.True(t, open, "still pending: nothing was decided")
}

// Security's SHOULD G. Mutant: the items are served through Coral Hub.
func TestHeldEditsAreNeedsYouItemsOnThisComputerOnly(t *testing.T) {
	be, _, e := heldEdit(t)
	items := DropboxEditItems(be.h.dbx.dataDir)
	req := httptest.NewRequest(http.MethodGet, "/api/needs-you", nil)
	got, err := items(req)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "dropbox_edit", got[0].Kind)
	assert.Equal(t, "dropbox_edit:"+e.DocID, got[0].ID)
	assert.Equal(t, "doc0.md was edited in Dropbox", got[0].Line, "Coral's own name, nothing from the edit")
	hub := httptest.NewRequest(http.MethodGet, "/api/needs-you", nil)
	hub.Header.Set(tunnel.ViaHeader, "1")
	got, err = items(hub)
	require.NoError(t, err)
	assert.Empty(t, got, "never through Coral Hub")
	st, _ := be.status()["edits"].(map[string]any)
	rows, _ := st["items"].([]any)
	require.Len(t, rows, 1)
	row := rows[0].(map[string]any)
	assert.EqualValues(t, 2, row["next_version"], "the version Promote would make now")
	assert.True(t, strings.HasPrefix(row["dropbox_url"].(string), "https://www.dropbox.com/home/Apps/coralhub/v1/"), row["dropbox_url"])
}

// Mutant: Promote of a file of no team writes something half-done or answers 500.
func TestPromoteOfAFileOfNoTeamSaysKeepItSeparate(t *testing.T) {
	be, ds := newDropboxEditEnv(t, 1)
	be.dbx.edit(be.versionFile(ds[0]), []byte("edited"))
	be.notice()
	open := be.open()
	require.Len(t, open, 1)
	rec := be.decide(open[0].DocID, "promote", true)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "no_team")
	assert.False(t, be.hasRecord(open[0].Digest), "nothing written")
	still, _ := be.b.edits.IsOpen(context.Background(), open[0].DocID)
	assert.True(t, still, "pending again")
	assert.Equal(t, http.StatusOK, be.decide(open[0].DocID, "separate", true).Code, "and Keep separate works")
}

// Security's conditions a to c on #14714 (21:21).

// Mutant: a decision takes an edit of an account that is not the one connected.
func TestADecisionRefusesAnotherAccountsEdit(t *testing.T) {
	be, _, e := heldEdit(t)
	_, err := be.db.ExecContext(context.Background(), "UPDATE dropbox_edits SET account_id = 'dbid:OLD' WHERE id = ?", e.ID)
	require.NoError(t, err)
	rec := be.decide(e.DocID, "promote", true)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "other_account")
	assert.False(t, be.hasRecord(e.Digest), "nothing stored")
}

// Mutant: a Disconnect (or another account, or a Rekey) leaves the edits and their bytes.
func TestDisconnectDropsTheEditsAndTheirFiles(t *testing.T) {
	be, _, e := heldEdit(t)
	require.NoError(t, be.h.dbx.store.Disconnect(context.Background()))
	be.notice()
	assert.Empty(t, be.open(), "the edits of an account no longer connected are dropped")
	_, err := os.Stat(be.b.heldPath(e.Digest))
	assert.True(t, os.IsNotExist(err), "and their held bytes")
}

// Mutants: the held bytes are not hashed again at the decision; a changed file stays stuck pending.
func TestAChangedHeldFileIsNotStoredAndIsFetchedAgain(t *testing.T) {
	be, _, e := heldEdit(t)
	require.NoError(t, os.WriteFile(be.b.heldPath(e.Digest), []byte("# doc 0, edited in Dropbox\nX"), 0o600)) // changed on this computer
	rec := be.decide(e.DocID, "promote", true)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "held_changed")
	assert.False(t, be.hasRecord(e.Digest), "the changed bytes are never stored")
	n := len(be.dbx.downloads)
	be.notice()
	assert.Len(t, be.dbx.downloads, n+1, "fetched again from Dropbox")
	open := be.open()
	require.Len(t, open, 1)
	assert.Equal(t, e.Digest, open[0].Digest, "with the bytes Dropbox has")
	assert.Equal(t, http.StatusOK, be.decide(e.DocID, "promote", true).Code, "and it can be decided")
}

// Mutant: the held file is opened through a link.
func TestALinkedHeldFileIsRefused(t *testing.T) {
	be, _, e := heldEdit(t)
	b, err := os.ReadFile(be.b.heldPath(e.Digest))
	require.NoError(t, err)
	elsewhere := filepath.Join(t.TempDir(), "same-bytes")
	require.NoError(t, os.WriteFile(elsewhere, b, 0o600))
	require.NoError(t, os.Remove(be.b.heldPath(e.Digest)))
	if err := os.Symlink(elsewhere, be.b.heldPath(e.Digest)); err != nil {
		t.Skipf("no symlinks: %v", err)
	}
	rec := be.decide(e.DocID, "separate", true)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.False(t, be.hasRecord(e.Digest))
}

// Mutant: the sweep removes anything in the held folder.
func TestTheSweepRemovesOnlyExactHexRegularFiles(t *testing.T) {
	be, _, _ := heldEdit(t)
	dir := be.b.heldDir()
	keep := map[string]func(string) error{
		"notes.txt":              func(p string) error { return os.WriteFile(p, []byte("x"), 0o600) },
		strings.Repeat("cd", 32): func(p string) error { return os.Mkdir(p, 0o700) },
	}
	for name, mk := range keep {
		require.NoError(t, mk(filepath.Join(dir, name)))
	}
	link := strings.Repeat("ef", 32)
	symlinked := os.Symlink(filepath.Join(dir, "notes.txt"), filepath.Join(dir, link)) == nil
	be.notice()
	for name := range keep {
		_, err := os.Lstat(filepath.Join(dir, name))
		assert.NoError(t, err, "%s stays: not an exact 64-hex regular file", name)
	}
	if symlinked {
		_, err := os.Lstat(filepath.Join(dir, link))
		assert.NoError(t, err, "a link is never removed through")
	}
}
