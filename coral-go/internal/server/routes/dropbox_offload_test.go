package routes

import (
	"context"
	"encoding/json"
	"errors"
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

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/secretbox"
)

// #14845, Dropbox stage 6b piece 2: the offload pass, against the fake Dropbox. Each test names the mutant it fails against.

// offloadEnv backs up one artifact, makes it 200 days old, turns Free up space on (90 days) and gives the pass an empty reference scan.
func offloadEnv(t *testing.T) (*backupEnv, string) {
	t.Helper()
	be := newBackupEnv(t)
	d := be.put("old.md", "text/markdown", "# an old file\n")
	be.pass()
	require.Equal(t, 2, be.inDropbox(d))
	_, err := be.db.Exec("UPDATE dropbox_outbox SET artifact_at = ? WHERE digest = ?", time.Now().Add(-200*24*time.Hour).UTC().Format(time.RFC3339), d)
	require.NoError(t, err)
	require.NoError(t, be.h.dbx.store.SetOffload(context.Background(), 90))
	be.b.references = func(context.Context) (map[string]bool, error) { return map[string]bool{}, nil }
	return be, d
}

func (be *backupEnv) offloaded(d string) bool {
	be.t.Helper()
	_, ok, err := be.b.outbox.Offloaded(context.Background(), d)
	require.NoError(be.t, err)
	return ok
}

func (be *backupEnv) objectHereNow(d string) bool {
	_, err := os.Lstat(be.objectPath(d))
	return err == nil
}

func (be *backupEnv) markerOf(d string) bool {
	id, _ := be.h.dbx.store.ServerID(context.Background())
	be.dbx.mu.Lock()
	defer be.dbx.mu.Unlock()
	_, ok := be.dbx.files[offloadMarker(d, id)]
	return ok
}

// Conditions 1, 3 and 4. Mutants: the bytes removed before the marker or the row; the sidecar or the records removed with them; the probe left behind.
func TestTheOffloadPassFreesAnOldBackedUpObject(t *testing.T) {
	be, d := offloadEnv(t)
	n, freed := be.b.Offload(context.Background())
	require.Equal(t, 1, n)
	assert.Positive(t, freed)
	assert.False(t, be.objectHereNow(d), "the local bytes are freed")
	assert.True(t, be.offloaded(d), "the offload row says where the copy is")
	assert.True(t, be.markerOf(d), "this Coral's marker is in Dropbox")
	_, err := os.Lstat(be.objectPath(d) + ".json")
	assert.NoError(t, err, "the sidecar stays: the artifact is still listed")
	assert.True(t, be.hasRecord(d), "its upload records stay")
	be.dbx.mu.Lock()
	for p := range be.dbx.files {
		assert.False(t, strings.HasPrefix(p, "/v1/probe/"), "the probe is deleted: %s", p)
	}
	be.dbx.mu.Unlock()
	a, _ := be.h.dbx.store.Audits(context.Background(), 1)
	require.Len(t, a, 1)
	assert.Equal(t, store.DropboxAuditOffloadPass, a[0].Kind)
	assert.Equal(t, 1, a[0].Count)
	n, _ = be.b.Offload(context.Background())
	assert.Zero(t, n, "at most once an hour")
}

// Mutants (one per case): each refusal dropped. Nothing is freed when the setting is off, the probe fails or reads back other bytes, the private
// marks or the reference scan cannot be read (fail closed), the artifact is private or referenced, or Dropbox's copy is not these exact bytes.
func TestTheOffloadPassFreesNothingUnlessEveryCheckHolds(t *testing.T) {
	cases := map[string]func(t *testing.T, be *backupEnv, d string){
		"the setting off": func(t *testing.T, be *backupEnv, d string) {
			require.NoError(t, be.h.dbx.store.SetOffload(context.Background(), 0))
		},
		"the probe unreadable":     func(t *testing.T, be *backupEnv, d string) { be.dbx.failDownloads = 1 },
		"the probe's bytes differ": func(t *testing.T, be *backupEnv, d string) { be.dbx.probeBad = true },
		"private marks unreadable": func(t *testing.T, be *backupEnv, d string) { be.privErr = errors.New("board unreadable") },
		"marked private":           func(t *testing.T, be *backupEnv, d string) { be.private[d] = true },
		"the reference scan fails": func(t *testing.T, be *backupEnv, d string) {
			be.b.references = func(context.Context) (map[string]bool, error) { return nil, errors.New("no scan") }
		},
		"a running task names it": func(t *testing.T, be *backupEnv, d string) {
			be.b.references = func(context.Context) (map[string]bool, error) { return map[string]bool{d: true}, nil }
		},
		"edited in Dropbox (another rev)": func(t *testing.T, be *backupEnv, d string) {
			be.dbx.revs = map[string]string{be.versionFile(d): "r2"}
		},
		"the local bytes are not the digest": func(t *testing.T, be *backupEnv, d string) {
			require.NoError(t, os.WriteFile(be.objectPath(d), []byte("other bytes"), 0o600))
		},
		"on battery": func(t *testing.T, be *backupEnv, d string) { be.b.power = func() (bool, bool) { return true, false } },
	}
	for name, refuse := range cases {
		t.Run(name, func(t *testing.T) {
			be, d := offloadEnv(t)
			refuse(t, be, d)
			n, _ := be.b.Offload(context.Background())
			assert.Zero(t, n)
			assert.True(t, be.objectHereNow(d), "the bytes stay")
			assert.False(t, be.offloaded(d), "no offload row")
		})
	}
}

// Condition 1a. Mutant: a probe a crash left is not deleted (it piles up, and the next listing would count it).
func TestAProbeACrashLeftIsDeleted(t *testing.T) {
	be, _ := offloadEnv(t)
	id, _ := be.h.dbx.store.ServerID(context.Background())
	be.dbx.mu.Lock()
	be.dbx.files["/v1/probe/"+id+"/left"] = []byte("x")
	be.dbx.mu.Unlock()
	n, _ := be.b.Offload(context.Background())
	require.Equal(t, 1, n)
	be.dbx.mu.Lock()
	defer be.dbx.mu.Unlock()
	for p := range be.dbx.files {
		assert.False(t, strings.HasPrefix(p, "/v1/probe/"), "no probe stays: %s", p)
	}
}

// offloadedEnv is offloadEnv after one pass: the object freed. The fake keeps the stored rev's bytes, as Dropbox keeps a file's revisions.
func offloadedEnv(t *testing.T) (*backupEnv, string, []byte) {
	t.Helper()
	be, d := offloadEnv(t)
	orig, err := os.ReadFile(be.objectPath(d))
	require.NoError(t, err)
	n, _ := be.b.Offload(context.Background())
	require.Equal(t, 1, n)
	be.dbx.mu.Lock()
	if be.dbx.revBytes == nil {
		be.dbx.revBytes = map[string][]byte{}
	}
	be.dbx.revBytes["r1"] = orig
	be.dbx.mu.Unlock()
	return be, d, orig
}

// Security's 3a. Mutants: the fetch served without the SHA-256 check; the marker or the row left after a fetch; the fetch not recorded as an open.
func TestFetchBackBringsTheExactBytesBack(t *testing.T) {
	be, d, orig := offloadedEnv(t)
	here, err := be.b.FetchBack(context.Background(), d)
	require.NoError(t, err)
	require.True(t, here)
	got, err := os.ReadFile(be.objectPath(d))
	require.NoError(t, err)
	assert.Equal(t, orig, got)
	assert.False(t, be.offloaded(d), "the row goes")
	assert.False(t, be.markerOf(d), "this Coral's marker goes")
	var opened int
	require.NoError(t, be.db.Get(&opened, "SELECT COUNT(*) FROM dropbox_opened WHERE digest = ?", d))
	assert.Equal(t, 1, opened, "a fetch is an open: not freed again for 30 days")
}

// Security's 3a and condition 9. Mutants: the fetch by the file's current rev (an edit made in Dropbox served under the old digest); other bytes
// stored; a fetch in another account.
func TestFetchBackNeverServesOtherBytes(t *testing.T) {
	t.Run("edited in Dropbox since: the stored rev", func(t *testing.T) {
		be, d, orig := offloadedEnv(t)
		p := be.versionFile(d)
		be.dbx.mu.Lock()
		be.dbx.files[p] = []byte("# edited in Dropbox\n")
		be.dbx.revs = map[string]string{p: "r2"}
		be.dbx.mu.Unlock()
		here, err := be.b.FetchBack(context.Background(), d)
		require.NoError(t, err)
		require.True(t, here)
		got, _ := os.ReadFile(be.objectPath(d))
		assert.Equal(t, orig, got, "the stored rev's bytes, never the edit's")
	})
	t.Run("bytes that are not the digest", func(t *testing.T) {
		be, d, _ := offloadedEnv(t)
		be.dbx.mu.Lock()
		be.dbx.revBytes["r1"] = []byte("something else")
		be.dbx.mu.Unlock()
		here, err := be.b.FetchBack(context.Background(), d)
		assert.Error(t, err)
		assert.False(t, here)
		assert.False(t, be.objectHereNow(d), "nothing stored")
		assert.True(t, be.offloaded(d), "nothing forgotten")
		assert.True(t, be.markerOf(d))
	})
	t.Run("another account connected", func(t *testing.T) {
		be, d, _ := offloadedEnv(t)
		_, err := be.db.Exec("UPDATE dropbox_offloaded SET account_id = 'dbid:OTHER' WHERE digest = ?", d)
		require.NoError(t, err)
		_, err = be.b.FetchBack(context.Background(), d)
		assert.ErrorIs(t, err, errOtherAccount)
		assert.False(t, be.objectHereNow(d))
	})
}

// Security's 3b. Mutants: Remove from Dropbox deletes the only copy of an offloaded artifact; a failed fetch-back removes anyway; a deleted
// artifact's own marker left behind.
func TestRemovingAnOffloadedArtifactFromDropboxFetchesItBackFirst(t *testing.T) {
	t.Run("still here: fetched back, then removed", func(t *testing.T) {
		be, d, orig := offloadedEnv(t)
		code, out := be.removeCall("remove", d, `{"confirm": true}`, true)
		require.Equal(t, 200, code, "%v", out)
		got, err := os.ReadFile(be.objectPath(d))
		require.NoError(t, err, "the bytes are back on this computer")
		assert.Equal(t, orig, got)
		assert.Zero(t, be.inDropbox(d), "then removed from Dropbox")
		assert.False(t, be.offloaded(d))
	})
	t.Run("the fetch fails: nothing removed", func(t *testing.T) {
		be, d, _ := offloadedEnv(t)
		be.dbx.mu.Lock()
		delete(be.dbx.revBytes, "r1")
		be.dbx.mu.Unlock()
		code, out := be.removeCall("remove", d, `{"confirm": true}`, true)
		assert.Equal(t, 409, code)
		assert.Equal(t, "kept_in_dropbox", out["code"])
		assert.Equal(t, 2, be.inDropbox(d), "the only copy stays")
		assert.True(t, be.offloaded(d))
	})
	t.Run("deleted here: its own marker goes, then the removal", func(t *testing.T) {
		be, d, _ := offloadedEnv(t)
		_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, d)
		require.NoError(t, err)
		code, out := be.removeCall("remove", d, `{"confirm": true}`, true)
		require.Equal(t, 200, code, "%v", out)
		assert.False(t, be.markerOf(d))
		assert.False(t, be.offloaded(d))
		assert.Zero(t, be.inDropbox(d))
	})
}

// Security's condition 5 and 3b on d766be37a. Mutants (one per route): the guard dropped from Disconnect (plain or with delete_backup), Switch
// or Take over, any of which would leave the files kept only in Dropbox with no way back.
func TestNothingStrandsFilesKeptOnlyInDropbox(t *testing.T) {
	for _, c := range []struct{ name, path, body string }{
		{"Disconnect", "/api/dropbox/disconnect", `{}`},
		{"Disconnect and delete the backup", "/api/dropbox/disconnect", `{"delete_backup": true, "typed": ["delete"]}`},
		{"Switch", "/api/dropbox/switch", `{}`},
		{"Take over", "/api/dropbox/takeover", `{}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			be, d, _ := offloadedEnv(t)
			be.body = c.body
			rec := be.call(http.MethodPost, c.path, true, nil)
			assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "kept_in_dropbox")
			assert.True(t, be.offloaded(d))
			assert.Equal(t, 2, be.inDropbox(d), "the only copy stays")
			st := be.status()
			assert.Equal(t, true, st["connected"], "still connected")
		})
	}
}

// Security's SHOULD on afb1f3213: Rekey is never refused for files kept only in Dropbox (it answers a leaked key); its confirm names their count,
// the rows stay, and a sign-in to the same account brings them back while another account is refused. Mutants: Rekey refused outright; the count
// not asked; the offload rows dropped by the re-key.
func TestARekeyAsksForTheCountThenKeepsTheWayBack(t *testing.T) {
	be, d, _ := offloadedEnv(t)
	require.NoError(t, os.Chmod(secretbox.KeyFilePath(be.h.dbx.dataDir), 0o644)) // the key is refused (others can read it): a re-key is allowed
	rekey := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/cloud/rekey", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		dashboardRequest(req)
		req.Host = be.host
		rec := httptest.NewRecorder()
		be.h.Rekey(rec, req)
		return rec
	}
	rec := rekey(`{"confirm": true}`)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"kept_in_dropbox":1`)
	assert.Contains(t, rec.Body.String(), "sign in to the same Dropbox account again")
	assert.Equal(t, true, be.status()["connected"], "nothing changed yet")
	rec = rekey(`{"confirm": true, "kept_in_dropbox": 1}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.True(t, be.offloaded(d), "the rows stay: the way back is a sign-in")
	_, err := be.b.FetchBack(context.Background(), d)
	assert.ErrorIs(t, err, errKeptInDropbox, "no sign-in: cannot be fetched yet")
	require.Contains(t, be.signIn(""), "Connected")
	here, err := be.b.FetchBack(context.Background(), d)
	require.NoError(t, err, "the same account again: fetched back")
	assert.True(t, here)
}

// Security's 3e. Mutant: the pending-receipt sweeper removes the record of an object kept only in Dropbox (it looks like a missing object).
func TestASweeperKeepsTheRecordsOfAnOffloadedObject(t *testing.T) {
	be, d, _ := offloadedEnv(t)
	require.False(t, be.objectHereNow(d))
	dir := t.TempDir()
	write := func(id string) string {
		b, err := json.Marshal(pendingReceipt{Rec: crossTeamArtifactRecord{ID: id, Name: "x.md"}, Source: "src", RelayID: "1", Arrived: time.Now().UnixNano()})
		require.NoError(t, err)
		p := filepath.Join(dir, "src-1-"+id+".json")
		require.NoError(t, os.WriteFile(p, b, 0o600))
		return p
	}
	kept := write(d)
	gone := write(strings.Repeat("9", 64)) // an object neither here nor in Dropbox
	(&BoardHandler{coralDir: be.h.dbx.dataDir}).sweepPending(dir)
	_, err := os.Stat(kept)
	assert.NoError(t, err, "the offloaded object's record stays")
	_, err = os.Stat(gone)
	assert.True(t, os.IsNotExist(err), "a record whose object is truly gone is still swept")
	assert.True(t, objectHereOrOffloaded(be.h.dbx.dataDir, d))
}

func (be *backupEnv) readArtifact(path, d string, operator bool) *httptest.ResponseRecorder {
	be.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if operator {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", d)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	h := be.sessions()
	if strings.HasSuffix(path, "/thumbnail") {
		h.artifactThumbnail(rec, req)
	} else {
		h.getAgentArtifact(rec, req)
	}
	return rec
}

// Security's 3c and 3d. Mutants: anyone's read fetches (an agent spends the Operator's Dropbox); a thumbnail fetches; the Operator's open not
// fetched, or not recorded.
func TestOnlyTheOperatorsOpenFetchesAnOffloadedFile(t *testing.T) {
	be, d, orig := offloadedEnv(t)
	rec := be.readArtifact("/api/artifacts/"+d, d, false)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "not the Operator: kept only in Dropbox")
	assert.Contains(t, rec.Body.String(), "kept_in_dropbox")
	rec = be.readArtifact("/api/artifacts/"+d+"/thumbnail", d, true)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "a thumbnail never fetches")
	assert.False(t, be.objectHereNow(d), "nothing fetched yet")
	rec = be.readArtifact("/api/artifacts/"+d, d, true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, orig, rec.Body.Bytes(), "the Operator's open fetches the exact bytes back and serves them")
	assert.False(t, be.offloaded(d))
	var at string
	require.NoError(t, be.db.Get(&at, "SELECT at FROM dropbox_opened WHERE digest = ?", d))
	assert.NotEmpty(t, at, "the open is recorded")
}

// Security's 3d (b). Mutants: Keep or Star refused on an offloaded file (Mark private, the board's route, asks the same objectHereOrOffloaded).
func TestAnOffloadedFileIsStillThere(t *testing.T) {
	be, d, _ := offloadedEnv(t)
	assert.True(t, objectHereOrOffloaded(be.h.dbx.dataDir, d))
	h := be.sessions()
	for _, path := range []string{"/api/artifacts/" + d + "/keep", "/api/artifacts/" + d + "/star"} {
		req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"private": true}`))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", d)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		rec := httptest.NewRecorder()
		switch {
		case strings.HasSuffix(path, "/keep"):
			h.keepArtifactRoute(rec, req)
		case strings.HasSuffix(path, "/star"):
			h.starArtifactRoute(rec, req)
		}
		assert.NotEqual(t, http.StatusNotFound, rec.Code, "%s works on a file kept only in Dropbox: %s", path, rec.Body.String())
	}
}

// Security's 3c. Mutant: the Operator's open of a file still here not recorded (it would be freed although in use); an agent's read recorded.
func TestTheOperatorsOpenIsRecorded(t *testing.T) {
	be, d := offloadEnv(t)
	require.Equal(t, http.StatusOK, be.readArtifact("/api/artifacts/"+d, d, false).Code)
	var n int
	require.NoError(t, be.db.Get(&n, "SELECT COUNT(*) FROM dropbox_opened WHERE digest = ?", d))
	assert.Zero(t, n, "an agent's read is not the Operator's open")
	require.Equal(t, http.StatusOK, be.readArtifact("/api/artifacts/"+d, d, true).Code)
	require.NoError(t, be.db.Get(&n, "SELECT COUNT(*) FROM dropbox_opened WHERE digest = ?", d))
	assert.Equal(t, 1, n)
	got, err := be.b.outbox.OffloadCandidates(context.Background(), "dbid:AAA", time.Now().Add(-90*24*time.Hour), time.Now().Add(-store.DropboxOffloadOpenedFor), 10)
	require.NoError(t, err)
	assert.Empty(t, got, "opened now: not freed for 30 days")
}
