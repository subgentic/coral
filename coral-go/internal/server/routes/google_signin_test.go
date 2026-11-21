package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/googlesignin"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20022: the Operator's Google sign-in routes and the token source, against a fake Google. No real client file, no real token.

const googleSecretText = "CLIENT-SECRET-MUST-NOT-LEAK"

type fakeGoogleServer struct {
	mu        sync.Mutex
	srv       *httptest.Server
	refreshes int
	revoked   []string
	dead      bool // refresh answers invalid_grant
	issued    int
}

func newFakeGoogleServer(t *testing.T) *fakeGoogleServer {
	f := &fakeGoogleServer{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			if r.PostForm.Get("grant_type") == "refresh_token" {
				f.refreshes++
				if f.dead {
					w.WriteHeader(400)
					_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
					return
				}
				_, _ = w.Write([]byte(`{"access_token":"acc-refreshed","expires_in":3600}`))
				return
			}
			f.issued++
			_, _ = w.Write([]byte(`{"access_token":"acc-1","refresh_token":"refresh-` + string(rune('0'+f.issued)) + `","expires_in":3600,"scope":"` + googlesignin.Scope + `"}`))
		case "/revoke":
			_ = r.ParseForm()
			f.revoked = append(f.revoked, r.PostForm.Get("token"))
		case "/drive/v3/about":
			_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"permissionId": "perm-1"}})
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type googleEnv struct {
	t    *testing.T
	h    *CloudHandler
	fake *fakeGoogleServer
	host string
	db   *store.DB
}

func newGoogleEnv(t *testing.T, clientBody string) *googleEnv {
	t.Helper()
	dir := t.TempDir()
	db, err := storetest.Open(t, filepath.Join(dir, "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewCloudHandler(store.NewSessionStore(db), dir)
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	h.SetGoogle(store.NewGoogleStore(db, store.NewRemoteServerStore(db, dir)))
	e := &googleEnv{t: t, h: h, fake: newFakeGoogleServer(t), host: "127.0.0.1:8420", db: db}
	if clientBody != "" {
		p := filepath.Join(dir, "client.json")
		require.NoError(t, os.WriteFile(p, []byte(clientBody), 0o600))
		h.ggl.clientFile = p
	}
	h.ggl.client = func(c googlesignin.ClientCreds) *googlesignin.Client {
		return googlesignin.NewClientAt(c, e.fake.srv.URL)
	}
	return e
}

func (e *googleEnv) call(method, path string, dashboard bool, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if dashboard {
		dashboardRequest(req)
		req.Host = e.host
	}
	rec := httptest.NewRecorder()
	switch path {
	case "/api/google/status":
		e.h.GoogleStatus(rec, req)
	case "/api/google/connect":
		e.h.GoogleConnect(rec, req)
	case "/api/google/disconnect":
		e.h.GoogleDisconnect(rec, req)
	}
	return rec
}

func (e *googleEnv) signIn() string {
	e.t.Helper()
	rec := e.call(http.MethodPost, "/api/google/connect", true, nil)
	require.Equal(e.t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]string
	require.NoError(e.t, json.Unmarshal(rec.Body.Bytes(), &out))
	u, err := url.Parse(out["authorize_url"])
	require.NoError(e.t, err)
	q := u.Query()
	assert.Equal(e.t, googlesignin.Scope, q.Get("scope"))
	cookie := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == googlesignin.FlowCookie {
			cookie = c.Value
			assert.True(e.t, c.HttpOnly)
		}
	}
	require.NotEmpty(e.t, cookie)
	req, _ := http.NewRequest(http.MethodGet, q.Get("redirect_uri")+"?code=the-code&state="+url.QueryEscape(q.Get("state")), nil)
	req.AddCookie(&http.Cookie{Name: googlesignin.FlowCookie, Value: cookie})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

const goodClient = `{"installed":{"client_id":"cid","client_secret":"` + googleSecretText + `"}}`

func TestTheGoogleRoutesAreTheOperatorsOnly(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	for _, p := range []string{"/api/google/status", "/api/google/connect", "/api/google/disconnect"} {
		m := http.MethodPost
		if strings.HasSuffix(p, "status") {
			m = http.MethodGet
		}
		assert.Equal(t, http.StatusForbidden, e.call(m, p, false, nil).Code, "%s without the dashboard (an agent, a script)", p)
		assert.Equal(t, http.StatusForbidden, e.call(m, p, true, map[string]string{tunnel.ViaHeader: "1"}).Code, "%s through the tunnel", p)
	}
}

func TestConnectNeedsAClientFileAndNeverEchoesIt(t *testing.T) {
	none := newGoogleEnv(t, "")
	rec := none.call(http.MethodPost, "/api/google/connect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "no_client")
	bad := newGoogleEnv(t, `{"installed":{"client_id":"x","client_secret":""}} `+googleSecretText)
	rec = bad.call(http.MethodPost, "/api/google/connect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.NotContains(t, rec.Body.String(), googleSecretText)
	off := bad.call(http.MethodGet, "/api/google/status", true, nil)
	assert.Contains(t, off.Body.String(), `"enabled":false`)
	assert.NotContains(t, off.Body.String(), "client_file_ok", "while the switch is off the client file is not read, so the status says nothing of it (#20212)")
	require.NoError(t, bad.h.ss.SetSetting(context.Background(), setreg.GdocShare, "true"))
	st := bad.call(http.MethodGet, "/api/google/status", true, nil)
	assert.NotContains(t, st.Body.String(), googleSecretText)
	assert.Contains(t, st.Body.String(), `"client_file_ok":false`)
}

func TestSigningInSealsTheTokenAndTheAccessTokenIsRefreshedInMemory(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	assert.Contains(t, e.signIn(), "Connected")
	st := e.call(http.MethodGet, "/api/google/status", true, nil)
	assert.NotContains(t, st.Body.String(), "refresh-1", "the status never carries the token")
	assert.NotContains(t, st.Body.String(), googleSecretText)
	var m map[string]any
	require.NoError(t, json.Unmarshal(st.Body.Bytes(), &m))
	assert.Equal(t, true, m["connected"])
	assert.Equal(t, "perm-1", m["account_id"])
	ctx := context.Background()
	tok, err := e.h.GoogleAccessToken(ctx)
	require.NoError(t, err)
	assert.Equal(t, "acc-1", tok, "the access token from the sign-in is held in memory")
	assert.Equal(t, 0, e.fake.refreshes, "no refresh while it is fresh")
	e.h.ggl.mu.Lock()
	e.h.ggl.expires = time.Now().Add(10 * time.Second) // inside the last minute
	e.h.ggl.mu.Unlock()
	tok, err = e.h.GoogleAccessToken(ctx)
	require.NoError(t, err)
	assert.Equal(t, "acc-refreshed", tok)
	assert.Equal(t, 1, e.fake.refreshes)
}

func TestAWrongBrowserOrStateFinishesNothing(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	rec := e.call(http.MethodPost, "/api/google/connect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	var out map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	u, _ := url.Parse(out["authorize_url"])
	req, _ := http.NewRequest(http.MethodGet, u.Query().Get("redirect_uri")+"?code=c&state="+url.QueryEscape(u.Query().Get("state")), nil)
	req.AddCookie(&http.Cookie{Name: googlesignin.FlowCookie, Value: "another-browser"})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Contains(t, string(b), "didn't finish")
	c, _ := e.h.ggl.store.Get(context.Background())
	assert.False(t, c.Connected)
}

func TestDisconnectRevokesAtGoogleAndForgetsTheTokenAndTheAccessToken(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	e.signIn()
	rec := e.call(http.MethodPost, "/api/google/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"revoked":true`)
	assert.Equal(t, []string{"refresh-1"}, e.fake.revoked)
	c, _ := e.h.ggl.store.Get(context.Background())
	assert.False(t, c.Connected)
	_, err := e.h.GoogleAccessToken(context.Background())
	assert.ErrorIs(t, err, ErrGoogleNotConnected, "no cached access token outlives a disconnect")
}

func TestASignInReplacingAnotherRevokesTheOldToken(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	e.signIn()
	e.signIn()
	assert.Equal(t, []string{"refresh-1"}, e.fake.revoked, "the replaced sign-in is revoked, the new one kept")
	tok, err := e.h.ggl.store.RefreshToken(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "refresh-2", tok)
}

func TestGoogleRefusingTheTokenMakesItReconnectNotBroken(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	e.signIn()
	e.h.ggl.mu.Lock()
	e.h.ggl.access, e.h.ggl.expires = "", time.Time{}
	e.h.ggl.mu.Unlock()
	e.fake.dead = true
	_, err := e.h.GoogleAccessToken(context.Background())
	assert.ErrorIs(t, err, ErrGoogleNotConnected)
	c, _ := e.h.ggl.store.Get(context.Background())
	assert.Equal(t, store.GoogleStateReconnect, c.State)
}

func TestThereIsNoWayToChangeTheClientFilePath(t *testing.T) {
	// The path is read from the environment once, when Coral starts (SetGoogle). No route takes it, and a later change of the environment does not move it.
	t.Setenv(googleClientFileEnv, "/first/path.json")
	e := newGoogleEnv(t, "")
	h := e.h
	h.SetGoogle(h.ggl.store)
	assert.Equal(t, "/first/path.json", h.ggl.clientFile)
	t.Setenv(googleClientFileEnv, "/agent/chosen.json")
	assert.Equal(t, "/first/path.json", h.ggl.clientFile)
}

// #20022 INFO 9: a new sign-in that cannot be saved is not left alive at Google.
func TestASignInThatCannotBeSavedIsRevokedAtGoogle(t *testing.T) {
	e := newGoogleEnv(t, goodClient)
	_, err := e.db.Exec("DROP TABLE google_connection")
	require.NoError(t, err)
	assert.Contains(t, e.signIn(), "didn't finish")
	assert.Equal(t, []string{"refresh-1"}, e.fake.revoked)
}
