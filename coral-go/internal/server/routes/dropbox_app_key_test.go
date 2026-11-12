package routes

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #15638 (the Operator, 2026-11-11): Coral ships no Dropbox app key; each person saves their own in Settings. These tests use the real key resolution
// (the handler's own), not the fixed key newDropboxEnv sets.

const (
	keyOne = "abcd" + "1234" + "efgh" + "5678" // joined, never one literal: gitleaks' generic-api-key rule reads a key-shaped value as a secret (#15707)
	keyTwo = "zyxw" + "9876" + "vuts" + "5432"
)

// newKeyEnv is a Dropbox env with the real key resolution and no environment key.
func newKeyEnv(t *testing.T) *dropboxEnv {
	t.Helper()
	t.Setenv("CORAL_DROPBOX_APP_KEY", "")
	e := newDropboxEnv(t)
	e.h.dbx.appKey = e.h.dbx.resolveAppKey
	return e
}

func (e *dropboxEnv) putKey(key string, confirm bool) *httptest.ResponseRecorder {
	e.t.Helper()
	body := `{"app_key":"` + key + `"`
	if confirm {
		body += `,"confirm":true`
	}
	e.body = body + `}`
	return e.call(http.MethodPut, "/api/dropbox/app-key", true, nil)
}

// newKeyEnvAt is newKeyEnv on an existing database (an upgraded data folder).
func newKeyEnvAt(t *testing.T, path, dir string) *dropboxEnv {
	t.Helper()
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewCloudHandler(store.NewSessionStore(db), dir)
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	h.SetDropbox(store.NewDropboxStore(db, store.NewRemoteServerStore(db, dir)), dir)
	e := &dropboxEnv{t: t, h: h, dbx: newFakeDropbox(t), machine: "machine-1", host: "127.0.0.1:8420", db: db}
	h.dbx.client = func(k string) *dropbox.Client { return dropbox.NewClientAt(k, e.dbx.srv.URL) }
	h.dbx.machineID = func() (string, error) { return e.machine, nil }
	h.dbx.port = 0
	return e
}

// Key order: the environment's key beats the saved one; the saved one is used when the environment has none; neither means none.
func TestTheAppKeyOrderIsEnvironmentThenSavedThenNone(t *testing.T) {
	e := newKeyEnv(t)
	assert.Equal(t, "", e.h.dbx.appKey(), "a build carries no key")
	assert.Equal(t, false, e.status()["app_key_set"])
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	assert.Equal(t, keyOne, e.h.dbx.appKey(), "the saved key")
	t.Setenv("CORAL_DROPBOX_APP_KEY", keyTwo)
	assert.Equal(t, keyTwo, e.h.dbx.appKey(), "the environment's key wins")
	st := e.status()
	assert.Equal(t, true, st["app_key_from_env"])
	assert.Equal(t, keyOne, st["app_key"], "Settings still holds what was saved")
	t.Setenv("CORAL_DROPBOX_APP_KEY", "")
	assert.Equal(t, keyOne, e.h.dbx.appKey())
}

// A saved key is the client id of the sign-in URL (and the setup message goes away).
func TestASavedAppKeyReachesTheSignInURL(t *testing.T) {
	e := newKeyEnv(t)
	assert.Equal(t, http.StatusConflict, e.call(http.MethodPost, "/api/dropbox/connect", true, nil).Code, "no key: Connect says so (no_app_key)")
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Contains(t, e.signIn(""), "Connected") // finishes the sign-in, so no callback listener is left open
	u, err := url.Parse(e.lastAuthorize)
	require.NoError(t, err)
	assert.Equal(t, keyOne, u.Query().Get("client_id"))
	assert.Equal(t, true, e.status()["app_key_set"])
}

func TestABadAppKeyIsRefusedAndNothingIsSaved(t *testing.T) {
	e := newKeyEnv(t)
	for _, bad := range []string{"short", "has space in it 123", "abcd-1234-efgh-5678", "abcd" + "1234" + "efgh" + "5678" + "abcd1234"} {
		rec := e.putKey(bad, false)
		assert.Equal(t, http.StatusBadRequest, rec.Code, bad)
		assert.Contains(t, rec.Body.String(), "bad_app_key")
	}
	assert.Equal(t, "", e.h.dbx.appKey())
}

// A sign-in belongs to the app it was made with: changing the key while connected asks first (409) and changes nothing; the confirm disconnects the old
// account (revoking it with the old key) and saves the new key.
func TestChangingTheKeyWhileConnectedNeedsAConfirmAndDisconnects(t *testing.T) {
	e := newKeyEnv(t)
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Contains(t, e.signIn(""), "Connected")
	rec := e.putKey(keyTwo, false)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "confirm_disconnect")
	assert.Equal(t, keyOne, e.h.dbx.appKey(), "nothing changed without the confirm")
	assert.Equal(t, true, e.status()["connected"])

	rec = e.putKey(keyTwo, true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, 1, e.dbx.revoked, "the old sign-in was ended at Dropbox, with the key it was made with")
	assert.Equal(t, keyTwo, e.h.dbx.appKey())
	st := e.status()
	assert.Equal(t, false, st["connected"])
	assert.Equal(t, false, st["paused_no_key"])
}

func TestSavingTheSameKeyChangesNothing(t *testing.T) {
	e := newKeyEnv(t)
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Contains(t, e.signIn(""), "Connected")
	rec := e.putKey(keyOne, false)
	assert.Equal(t, http.StatusOK, rec.Code, "the same key needs no confirm")
	assert.Equal(t, true, e.status()["connected"])
}

func TestAnEmptyKeyRemovesTheSavedOne(t *testing.T) {
	e := newKeyEnv(t)
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Equal(t, http.StatusOK, e.putKey("", false).Code)
	assert.Equal(t, "", e.h.dbx.appKey())
}

func TestTheAppKeyRouteIsTheOperatorsOnly(t *testing.T) {
	e := newKeyEnv(t)
	e.body = `{"app_key":"` + keyOne + `"}`
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodPut, "/api/dropbox/app-key", false, nil).Code, "an agent or a script")
	e.body = `{"app_key":"` + keyOne + `"}`
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodPut, "/api/dropbox/app-key", true, map[string]string{tunnel.ViaHeader: "1"}).Code, "through the tunnel")
	assert.Equal(t, "", e.h.dbx.appKey(), "nothing was saved")
}

// The upgrade (never break Coral on upgrade): a data folder shaped by v2.0.64 has a connected Dropbox row and no app_key column. It opens, the sign-in is kept,
// the backup is paused (not broken), the status says so, and adding the person's key (with the confirm) lets them connect again.
func TestAV2064DataFolderUpgradesToPausedUntilAKeyIsAdded(t *testing.T) {
	t.Setenv("CORAL_DROPBOX_APP_KEY", "")
	dir := t.TempDir()
	path := filepath.Join(dir, "c.db")
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	ds := store.NewDropboxStore(db, store.NewRemoteServerStore(db, dir))
	ctx := context.Background()
	require.NoError(t, ds.Save(ctx, "dbid:AAA", "refresh-secret", "fp"))
	_, err = db.ExecContext(ctx, "ALTER TABLE dropbox_connection DROP COLUMN app_key") // v2.0.64 had no such column
	require.NoError(t, err)
	require.NoError(t, db.Close())

	e := newKeyEnvAt(t, path, dir)
	st := e.status()
	assert.Equal(t, true, st["connected"], "the sign-in survives the upgrade")
	assert.Equal(t, true, st["paused_no_key"])
	assert.Equal(t, false, st["app_key_set"])
	assert.False(t, (&DropboxBackup{d: e.h.dbx}).ready(ctx), "the backup waits for a key")

	assert.Equal(t, http.StatusConflict, e.putKey(keyOne, false).Code, "the old sign-in belongs to the old app: confirm first")
	require.Equal(t, http.StatusOK, e.putKey(keyOne, true).Code)
	st = e.status()
	assert.Equal(t, false, st["paused_no_key"])
	assert.Equal(t, false, st["connected"], "connect again with the new key")
	assert.Equal(t, true, st["app_key_set"])
}

// The key is never logged: not when saved, changed, removed, or used to sign in.
func TestTheAppKeyIsNeverLogged(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	e := newKeyEnv(t)
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Contains(t, e.signIn(""), "Connected")
	require.Equal(t, http.StatusOK, e.putKey(keyTwo, true).Code)
	require.Equal(t, http.StatusOK, e.putKey("", false).Code)
	assert.Contains(t, buf.String(), "the app key was changed", "the change is logged")
	assert.NotContains(t, buf.String(), keyOne)
	assert.NotContains(t, buf.String(), keyTwo)
}

// Security's SHOULD on #15648: with CORAL_DROPBOX_APP_KEY set, the key in use is the environment's whatever is saved, so changing the saved key must not disconnect
// the account (and needs no confirm). Failing-first: it answered 409 confirm_disconnect, and with the confirm it disconnected and revoked.
func TestSavingAKeyWhileTheEnvironmentKeyWinsKeepsTheAccountConnected(t *testing.T) {
	e := newKeyEnv(t)
	t.Setenv("CORAL_DROPBOX_APP_KEY", keyOne)
	require.Contains(t, e.signIn(""), "Connected")
	rec := e.putKey(keyTwo, false)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"env_wins":true`)
	assert.Equal(t, 0, e.dbx.revoked, "the sign-in was not ended at Dropbox")
	st := e.status()
	assert.Equal(t, true, st["connected"], "still connected")
	assert.Equal(t, keyTwo, st["app_key"], "the saved key is kept for when the environment's is gone")
	assert.Equal(t, keyOne, e.h.dbx.appKey(), "the environment's key is still the one in use")
}

// Security's INFO on #15648: the status carries the saved key (a public client id, for Settings' field), so the route stays the Operator's: refused to an agent token,
// to a request through the tunnel (Coral Hub), and a refused answer never holds the key.
func TestTheStatusWithTheSavedKeyIsClosedToAgentsAndTheHub(t *testing.T) {
	e := newKeyEnv(t)
	require.Equal(t, http.StatusOK, e.putKey(keyOne, false).Code)
	require.Contains(t, e.status()["app_key"], keyOne, "the Operator's own read has it")
	for name, hdr := range map[string]map[string]string{
		"an agent token":    {"Authorization": "Bearer agent-token-" + "0123456789"},
		"a session token":   {"X-Coral-Session-Token": "agent-token-" + "0123456789"},
		"through Coral Hub": {tunnel.ViaHeader: "1"},
	} {
		rec := e.call(http.MethodGet, "/api/dropbox/status", name == "through Coral Hub", hdr)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.NotContains(t, rec.Body.String(), keyOne, name)
	}
	rec := e.call(http.MethodGet, "/api/dropbox/status", false, nil)
	assert.Equal(t, http.StatusForbidden, rec.Code, "no dashboard (a script)")
	assert.NotContains(t, rec.Body.String(), keyOne)
}
