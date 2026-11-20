package googlesignin

import (
	"context"
	"encoding/json"
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
)

// #20022: the Google client file, the PKCE flow and the token calls, against a fake Google. No real client, no real token.

const secretText = "SUPER-SECRET-CLIENT-TEXT"

func writeClient(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "client.json")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	return p
}

func TestTheClientFileIsReadAtRunTimeAndNeverEchoed(t *testing.T) {
	c, err := LoadClientFile(writeClient(t, `{"installed":{"client_id":"id-1","client_secret":"`+secretText+`"}}`))
	require.NoError(t, err)
	assert.Equal(t, "id-1", c.ID)
	assert.Equal(t, secretText, c.Secret)
	assert.NotContains(t, c.String(), secretText, "a stray %v cannot print the secret")
	for _, bad := range []string{`{"installed":{"client_id":"","client_secret":"` + secretText + `"}}`, `not json ` + secretText, `{"installed":{"client_id":"x"}}`, `{}`, strings.Repeat(secretText, 10000)} {
		_, err := LoadClientFile(writeClient(t, bad))
		require.ErrorIs(t, err, ErrClientFile)
		assert.NotContains(t, err.Error(), secretText, "the fixed sentence carries nothing of the file")
	}
	for _, path := range []string{"", filepath.Join(t.TempDir(), "missing.json")} {
		_, err := LoadClientFile(path)
		assert.Equal(t, ErrClientFile, err)
		if path != "" {
			assert.NotContains(t, err.Error(), filepath.Base(path), "not even the path")
		}
	}
}

func TestStartMakesAnS256PKCEUrlForOneScopeOnTheLoopbackOnly(t *testing.T) {
	f := NewFlows()
	redirect := "http://127.0.0.1:50123/google/callback"
	u, err := f.Start("cid", redirect, "binding-1")
	require.NoError(t, err)
	pu, _ := url.Parse(u)
	q := pu.Query()
	assert.Equal(t, "accounts.google.com", pu.Host)
	assert.Equal(t, "S256", q.Get("code_challenge_method"))
	assert.NotEmpty(t, q.Get("code_challenge"))
	assert.Equal(t, Scope, q.Get("scope"), "drive.file, as the one scope")
	assert.Equal(t, "offline", q.Get("access_type"))
	assert.NotContains(t, u, "code_verifier", "the verifier never leaves")
	for _, bad := range []string{"http://evil.example/google/callback", "http://127.0.0.1:50123/other", "https://127.0.0.1:50123/google/callback", "http://localhost:50123/google/callback"} {
		_, err := f.Start("cid", bad, "b")
		assert.Error(t, err, bad)
	}
	_, err = f.Start("cid", redirect, "")
	assert.Error(t, err, "bound to a browser")
	// a wrong state or browser changes nothing; the right ones consume it, once
	u, _ = f.Start("cid", redirect, "binding-1")
	state := mustQ(t, u, "state")
	_, _, ok := f.Take("guess", "binding-1")
	assert.False(t, ok)
	_, _, ok = f.Take(state, "other-browser")
	assert.False(t, ok)
	assert.True(t, f.Pending(), "a guess cannot cancel the sign-in")
	v, r, ok := f.Take(state, "binding-1")
	assert.True(t, ok)
	assert.NotEmpty(t, v)
	assert.Equal(t, redirect, r)
	_, _, ok = f.Take(state, "binding-1")
	assert.False(t, ok, "taken once")
}

func TestAFlowExpires(t *testing.T) {
	f := NewFlows()
	now := time.Now()
	f.now = func() time.Time { return now }
	u, _ := f.Start("cid", "http://127.0.0.1:50123/google/callback", "b")
	now = now.Add(FlowTTL + time.Second)
	_, _, ok := f.Take(mustQ(t, u, "state"), "b")
	assert.False(t, ok)
	assert.False(t, f.Pending())
}

func mustQ(t *testing.T, raw, key string) string {
	t.Helper()
	u, err := url.Parse(raw)
	require.NoError(t, err)
	return u.Query().Get(key)
}

type fakeGoogle struct {
	mu      sync.Mutex
	scope   string
	grant   bool // refresh answers invalid_grant
	revoked []string
	forms   []url.Values
	account string
	srv     *httptest.Server
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	f := &fakeGoogle{scope: Scope, account: "perm-1"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			f.forms = append(f.forms, r.PostForm)
			if r.PostForm.Get("grant_type") == "refresh_token" && f.grant {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"Token has been expired or revoked. secret-path"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"acc-1","refresh_token":"ref-1","expires_in":3600,"scope":"` + f.scope + `"}`))
		case "/revoke":
			_ = r.ParseForm()
			f.revoked = append(f.revoked, r.PostForm.Get("token"))
		case "/drive/v3/about":
			if r.Header.Get("Authorization") != "Bearer acc-1" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"permissionId": f.account}})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func TestExchangeRefreshAccountAndRevoke(t *testing.T) {
	g := newFakeGoogle(t)
	c := NewClientAt(ClientCreds{ID: "cid", Secret: secretText}, g.srv.URL)
	ctx := context.Background()
	tok, err := c.Exchange(ctx, "the-code", "the-verifier", "http://127.0.0.1:1/google/callback")
	require.NoError(t, err)
	assert.Equal(t, "ref-1", tok.Refresh)
	last := g.forms[len(g.forms)-1]
	assert.Equal(t, "the-verifier", last.Get("code_verifier"), "PKCE")
	assert.Equal(t, secretText, last.Get("client_secret"), "the client secret goes to the token endpoint only")
	acct, err := c.AccountID(ctx, tok.Access)
	require.NoError(t, err)
	assert.Equal(t, "perm-1", acct)
	acc, ttl, err := c.Refresh(ctx, "ref-1")
	require.NoError(t, err)
	assert.Equal(t, "acc-1", acc)
	assert.Equal(t, time.Hour, ttl)
	require.NoError(t, c.Revoke(ctx, "ref-1"))
	assert.Equal(t, []string{"ref-1"}, g.revoked)
}

func TestAWiderGrantThanDriveFileIsRefused(t *testing.T) {
	g := newFakeGoogle(t)
	g.scope = Scope + " https://www.googleapis.com/auth/drive"
	c := NewClientAt(ClientCreds{ID: "cid", Secret: "s"}, g.srv.URL)
	_, err := c.Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/google/callback")
	assert.ErrorIs(t, err, ErrScope)
	g.scope = ""
	_, err = c.Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/google/callback")
	assert.ErrorIs(t, err, ErrScope, "no scope named is not drive.file")
}

func TestErrorsCarryTheTagOnlyNeverGoogleTextOrTheSecret(t *testing.T) {
	g := newFakeGoogle(t)
	g.grant = true
	c := NewClientAt(ClientCreds{ID: "cid", Secret: secretText}, g.srv.URL)
	_, _, err := c.Refresh(context.Background(), "ref-1")
	require.ErrorIs(t, err, ErrInvalidGrant)
	assert.NotContains(t, err.Error(), "secret-path")
	assert.NotContains(t, err.Error(), secretText)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := dead.URL
	dead.Close()
	c2 := NewClientAt(ClientCreds{ID: "cid", Secret: secretText}, url)
	_, _, err = c2.Refresh(context.Background(), "ref-1")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), secretText)
	assert.NotContains(t, err.Error(), "ref-1")
}

func TestTheRealClientTalksOnlyToGoogleOverTLS(t *testing.T) {
	c := NewClient(ClientCreds{ID: "cid", Secret: "s"})
	for _, u := range []string{"https://evil.example/token", "http://oauth2.googleapis.com/token", "https://oauth2.googleapis.com.evil.example/token"} {
		req, _ := http.NewRequest("GET", u, nil)
		_, err := c.hc.Do(req)
		require.Error(t, err, u)
		assert.ErrorIs(t, err, ErrHostNotAllowed, u)
	}
}

func TestTheCallbackListenerAnswersOneRequestOnTheLoopback(t *testing.T) {
	got := make(chan CallbackResult, 2)
	redirect, err := ServeCallbackOnce(0, 5*time.Second, func(r CallbackResult) string { got <- r; return "ok" })
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(redirect, "http://127.0.0.1:"))
	req, _ := http.NewRequest("GET", redirect+"?code=c1&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: FlowCookie, Value: "bind"})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, CallbackResult{Code: "c1", State: "s1", Binding: "bind"}, <-got)
	resp2, err := http.Get(redirect + "?code=c2&state=s2")
	if err == nil {
		resp2.Body.Close()
		assert.Equal(t, http.StatusGone, resp2.StatusCode, "a second request is refused")
	}
	assert.Empty(t, got, "the handler ran once")
}

// #20022 INFO 10: a reserved port answers nothing until Serve, and Close gives it back.
func TestAReservedCallbackAnswersNothingUntilServedAndCloseFreesIt(t *testing.T) {
	cb, err := ReserveCallback(0)
	require.NoError(t, err)
	hit := make(chan struct{}, 1)
	client := &http.Client{Timeout: 300 * time.Millisecond}
	_, err = client.Get(cb.Redirect)
	assert.Error(t, err, "nothing answers before Serve")
	cb.Serve(5*time.Second, func(CallbackResult) string { hit <- struct{}{}; return "ok" })
	resp, err := http.Get(cb.Redirect + "?code=c&state=s")
	require.NoError(t, err)
	resp.Body.Close()
	<-hit

	cb2, err := ReserveCallback(0)
	require.NoError(t, err)
	cb2.Close()
	_, err = client.Get(cb2.Redirect)
	assert.Error(t, err, "a closed reservation is not listening")
}
