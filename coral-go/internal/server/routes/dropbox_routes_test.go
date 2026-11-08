package routes

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14609, Dropbox stage 3a, piece 3: the Operator's Dropbox routes and the browser's return on the one-shot listener, against a fake Dropbox.

type fakeDropbox struct {
	mu          sync.Mutex
	account     string // the account the next code signs in as
	badCode     bool   // the token endpoint answers invalid_grant to the next code
	revokeFails bool
	revoked     int
	srv         *httptest.Server
}

func newFakeDropbox(t *testing.T) *fakeDropbox {
	f := &fakeDropbox{account: "dbid:AAA"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/oauth2/token":
			_ = r.ParseForm()
			if r.PostForm.Get("grant_type") == "authorization_code" {
				if f.badCode {
					w.WriteHeader(http.StatusBadRequest)
					w.Write([]byte(`{"error":"invalid_grant"}`))
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"access_token": "a-" + f.account, "refresh_token": "refresh-secret-" + f.account, "account_id": f.account, "expires_in": 14400})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "a1", "expires_in": 14400})
		case "/2/auth/token/revoke":
			if f.revokeFails {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			f.revoked++
			w.Write([]byte("null"))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type dropboxEnv struct {
	t       *testing.T
	h       *CloudHandler
	dbx     *fakeDropbox
	machine string
}

func newDropboxEnv(t *testing.T) *dropboxEnv {
	t.Helper()
	dir := t.TempDir()
	db, err := storetest.Open(t, filepath.Join(dir, "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewCloudHandler(store.NewSessionStore(db), dir)
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	h.SetDropbox(store.NewDropboxStore(db, store.NewRemoteServerStore(db, dir)), dir)
	e := &dropboxEnv{t: t, h: h, dbx: newFakeDropbox(t), machine: "machine-1"}
	h.dbx.appKey = func() string { return "appkey" }
	h.dbx.client = func(k string) *dropbox.Client { return dropbox.NewClientAt(k, e.dbx.srv.URL) }
	h.dbx.machineID = func() (string, error) { return e.machine, nil }
	h.dbx.port = 0
	return e
}

func (e *dropboxEnv) call(method, path string, dashboard bool, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if dashboard {
		dashboardRequest(req)
	}
	rec := httptest.NewRecorder()
	switch path {
	case "/api/dropbox/status":
		e.h.DropboxStatus(rec, req)
	case "/api/dropbox/connect":
		e.h.DropboxConnect(rec, req)
	case "/api/dropbox/disconnect":
		e.h.DropboxDisconnect(rec, req)
	case "/api/dropbox/switch":
		e.h.DropboxConfirmSwitch(rec, req)
	case "/api/dropbox/takeover":
		e.h.DropboxTakeOver(rec, req)
	}
	return rec
}

func (e *dropboxEnv) status() map[string]any {
	e.t.Helper()
	rec := e.call(http.MethodGet, "/api/dropbox/status", true, nil)
	require.Equal(e.t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(e.t, rec.Body.String(), "refresh-secret", "the status never carries the token")
	var m map[string]any
	require.NoError(e.t, json.Unmarshal(rec.Body.Bytes(), &m))
	return m
}

// signIn starts a sign-in and comes back as a browser would: with the flow cookie (binding "" means keep the real one) and the state from the URL.
func (e *dropboxEnv) signIn(binding string) string {
	e.t.Helper()
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	require.Equal(e.t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]string
	require.NoError(e.t, json.Unmarshal(rec.Body.Bytes(), &out))
	u, err := url.Parse(out["authorize_url"])
	require.NoError(e.t, err)
	q := u.Query()
	cookie := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == dropbox.FlowCookie {
			cookie = c.Value
			assert.True(e.t, c.HttpOnly)
			assert.Equal(e.t, dropbox.CallbackPath, c.Path)
		}
	}
	require.NotEmpty(e.t, cookie)
	if binding != "" {
		cookie = binding
	}
	req, _ := http.NewRequest(http.MethodGet, q.Get("redirect_uri")+"?code=the-code&state="+url.QueryEscape(q.Get("state")), nil)
	req.AddCookie(&http.Cookie{Name: dropbox.FlowCookie, Value: cookie})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func TestTheDropboxRoutesAreTheOperatorsOnly(t *testing.T) {
	e := newDropboxEnv(t)
	for _, p := range []string{"/api/dropbox/status", "/api/dropbox/connect", "/api/dropbox/disconnect", "/api/dropbox/switch", "/api/dropbox/takeover"} {
		m := http.MethodPost
		if strings.HasSuffix(p, "status") {
			m = http.MethodGet
		}
		assert.Equal(t, http.StatusForbidden, e.call(m, p, false, nil).Code, "%s without the dashboard (an agent, a script)", p)
		assert.Equal(t, http.StatusForbidden, e.call(m, p, true, map[string]string{tunnel.ViaHeader: "1"}).Code, "%s through the tunnel", p)
	}
}

func TestConnectWithoutAnAppKeyIsRefused(t *testing.T) {
	e := newDropboxEnv(t)
	e.h.dbx.appKey = func() string { return "" }
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "no_app_key")
	assert.Equal(t, false, e.status()["app_key_set"])
}

func TestASignInConnectsAndTheStatusNeverCarriesTheToken(t *testing.T) {
	e := newDropboxEnv(t)
	assert.Equal(t, false, e.status()["connected"])
	assert.Contains(t, e.signIn(""), "Connected")
	st := e.status()
	assert.Equal(t, true, st["connected"])
	assert.Equal(t, "dbid:AAA", st["account_id"])
	assert.Equal(t, false, st["looks_like_copy"])
}

func TestASignInFinishedFromAnotherBrowserChangesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	assert.Contains(t, e.signIn("someone-elses-cookie"), "didn't finish")
	assert.Equal(t, false, e.status()["connected"])
}

func TestAFailedExchangeDeletesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	e.dbx.badCode = true
	assert.Contains(t, e.signIn(""), "didn't finish")
	st := e.status()
	assert.Equal(t, true, st["connected"], "an invalid_grant on a code is a bad code, not a revoked sign-in")
	assert.Equal(t, "dbid:AAA", st["account_id"])
}

func TestAnotherAccountWaitsForTheOperatorsConfirm(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	require.Equal(t, http.StatusOK, e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil).Code)
	e.dbx.account = "dbid:BBB"
	assert.Contains(t, e.signIn(""), "different Dropbox account")
	st := e.status()
	assert.Equal(t, false, st["connected"], "nothing is saved before the confirm")
	assert.Equal(t, map[string]any{"from": "dbid:AAA", "to": "dbid:BBB"}, st["switch_pending"])
	rec := e.call(http.MethodPost, "/api/dropbox/switch", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	st = e.status()
	assert.Equal(t, true, st["connected"])
	assert.Equal(t, "dbid:BBB", st["account_id"])
	assert.Equal(t, http.StatusConflict, e.call(http.MethodPost, "/api/dropbox/switch", true, nil).Code, "nothing waits any more")
}

func TestDisconnectRevokesFirstAndClearsEvenIfTheRevokeFails(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	rec := e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"revoked":true`)
	assert.Equal(t, 1, e.dbx.revoked)
	assert.Equal(t, false, e.status()["connected"])

	require.Contains(t, e.signIn(""), "Connected")
	e.dbx.revokeFails = true
	rec = e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"revoked":false`, "it says the revoke failed")
	assert.Equal(t, false, e.status()["connected"], "and forgets the sign-in here anyway")
}

func TestACopyOnAnotherMachineLooksLikeACopyUntilTakeOver(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	assert.Equal(t, false, e.status()["looks_like_copy"])
	e.machine = "machine-2"
	assert.Equal(t, true, e.status()["looks_like_copy"], "the data folder was started on another computer")
	require.Equal(t, http.StatusOK, e.call(http.MethodPost, "/api/dropbox/takeover", true, nil).Code)
	assert.Equal(t, false, e.status()["looks_like_copy"])
}

func TestAnUnreadableMachineIDStillWorks(t *testing.T) {
	e := newDropboxEnv(t)
	e.h.dbx.machineID = func() (string, error) { return "", errors.New("no id") }
	assert.Contains(t, e.signIn(""), "Connected", "the copy check falls back to the data folder")
}
