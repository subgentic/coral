package dropbox

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14609, Dropbox stage 3a, piece 2: the one client that talks to Dropbox, and the sign-in flow (PKCE, a single-use state).

func TestTheClientOnlyTalksToDropboxsHosts(t *testing.T) {
	c := NewClient("appkey")
	for _, u := range []string{"https://evil.example/2/files/upload", "http://api.dropboxapi.com/2/x", "https://api.dropboxapi.com.evil.example/2/x"} {
		req, err := http.NewRequest(http.MethodPost, u, nil)
		require.NoError(t, err)
		_, err = c.hc.Do(req)
		assert.ErrorIs(t, err, ErrHostNotAllowed, u)
	}
	for _, h := range []string{"api.dropboxapi.com", "content.dropboxapi.com", "api.dropbox.com"} {
		assert.True(t, allowedHost(h), h)
	}
}

func TestTheClientNeverFollowsARedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("a redirect was followed") }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer srv.Close()
	c := newTestClient(t, srv)
	resp, err := c.hc.Get(srv.URL + "/2/x")
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusFound, resp.StatusCode)
}

func TestTheAuthorizeURLAsksForPKCEAndAnOfflineToken(t *testing.T) {
	f := NewFlows()
	u, err := f.Start("appkey", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	require.NoError(t, err)
	p, err := url.Parse(u)
	require.NoError(t, err)
	assert.Equal(t, "www.dropbox.com", p.Host)
	q := p.Query()
	assert.Equal(t, "appkey", q.Get("client_id"))
	assert.Equal(t, "code", q.Get("response_type"))
	assert.Equal(t, "S256", q.Get("code_challenge_method"))
	assert.Equal(t, "offline", q.Get("token_access_type"))
	assert.Equal(t, "http://127.0.0.1:53682/dropbox/callback", q.Get("redirect_uri"))
	state := q.Get("state")
	require.Len(t, state, 43, "32 random bytes, base64url")
	verifier, redirect, ok := f.Take(state, "browser-1")
	assert.Equal(t, "http://127.0.0.1:53682/dropbox/callback", redirect, "the redirect captured at Start")
	require.True(t, ok)
	sum := sha256.Sum256([]byte(verifier))
	assert.Equal(t, base64.RawURLEncoding.EncodeToString(sum[:]), q.Get("code_challenge"), "the challenge is S256 of the verifier")
	assert.NotContains(t, u, verifier, "the verifier never leaves the server")
}

func TestAStateIsUsedOnceAndExpires(t *testing.T) {
	f := NewFlows()
	u, err := f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	require.NoError(t, err)
	p, _ := url.Parse(u)
	state := p.Query().Get("state")
	_, _, ok := f.Take("not-the-state", "browser-1")
	assert.False(t, ok)
	_, _, ok = f.Take(state, "browser-1")
	assert.True(t, ok)
	_, _, ok = f.Take(state, "browser-1")
	assert.False(t, ok, "single use")

	u, err = f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	require.NoError(t, err)
	p, _ = url.Parse(u)
	f.now = func() time.Time { return time.Now().Add(FlowTTL + time.Second) }
	_, _, ok = f.Take(p.Query().Get("state"), "browser-1")
	assert.False(t, ok, "expired after five minutes")
}

func TestOnlyOneSignInIsPendingAtATime(t *testing.T) {
	f := NewFlows()
	u1, _ := f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	u2, _ := f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	p1, _ := url.Parse(u1)
	p2, _ := url.Parse(u2)
	_, _, ok := f.Take(p1.Query().Get("state"), "browser-1")
	assert.False(t, ok, "a new sign-in replaces the pending one")
	_, _, ok = f.Take(p2.Query().Get("state"), "browser-1")
	assert.True(t, ok)
}

func TestExchangeRefreshAndRevoke(t *testing.T) {
	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth2/token":
			require.NoError(t, r.ParseForm())
			gotForm = r.PostForm
			if r.PostForm.Get("refresh_token") == "dead" {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":"invalid_grant","error_description":"refresh token is invalid or revoked"}`))
				return
			}
			if r.PostForm.Get("refresh_token") == "busy" {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Write([]byte(`{"access_token":"sl.access","expires_in":14400,"token_type":"bearer","refresh_token":"r1","account_id":"dbid:AAA","scope":"files.content.read"}`))
		case "/2/auth/token/revoke":
			assert.Equal(t, "Bearer sl.access", r.Header.Get("Authorization"))
			w.Write([]byte("null"))
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()

	tok, err := c.Exchange(ctx, "the-code", "the-verifier", "http://127.0.0.1:53682/dropbox/callback")
	require.NoError(t, err)
	assert.Equal(t, "r1", tok.Refresh)
	assert.Equal(t, "dbid:AAA", tok.AccountID)
	assert.Equal(t, "authorization_code", gotForm.Get("grant_type"))
	assert.Equal(t, "the-verifier", gotForm.Get("code_verifier"))
	assert.Empty(t, gotForm.Get("client_secret"), "a public client: no secret")

	access, err := c.Refresh(ctx, "r1")
	require.NoError(t, err)
	assert.Equal(t, "sl.access", access)
	_, err = c.Refresh(ctx, "dead")
	assert.ErrorIs(t, err, ErrInvalidGrant, "Dropbox no longer accepts it: reconnect")
	_, err = c.Refresh(ctx, "busy")
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrInvalidGrant, "an outage is not a revoked sign-in")
	assert.NotContains(t, err.Error(), "busy", "errors never carry a token")

	require.NoError(t, c.Revoke(ctx, "sl.access"))
}

func TestErrorsNeverCarryDropboxsBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_request","error_description":"path /secret/report.md not found"}`))
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	_, err := c.Exchange(context.Background(), "c", "v", "r")
	require.Error(t, err)
	assert.False(t, strings.Contains(err.Error(), "report.md"), "only the error tag, never Dropbox's description: %v", err)
	assert.Contains(t, err.Error(), "invalid_request")
}

func TestTheStateIsBoundToTheBrowserThatStartedTheSignIn(t *testing.T) {
	f := NewFlows()
	u, err := f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "browser-1")
	require.NoError(t, err)
	p, _ := url.Parse(u)
	state := p.Query().Get("state")
	_, _, ok := f.Take(state, "browser-2")
	assert.False(t, ok, "another browser (no or another flow cookie) cannot finish it")
	_, _, ok = f.Take(state, "")
	assert.False(t, ok)
	_, _, ok = f.Take(state, "browser-1")
	assert.True(t, ok, "a wrong browser does not consume the flow")
}

func TestStartAcceptsOnlyTheLoopbackCallback(t *testing.T) {
	f := NewFlows()
	for _, r := range []string{"http://localhost:53682/dropbox/callback", "https://127.0.0.1:53682/dropbox/callback", "http://127.0.0.1:53682/other",
		"http://127.0.0.1/dropbox/callback", "http://127.0.0.1:53682/dropbox/callback?x=1", "http://evil.example/dropbox/callback", "http://0.0.0.0:53682/dropbox/callback"} {
		_, err := f.Start("k", r, "browser-1")
		assert.Error(t, err, r)
	}
	_, err := f.Start("k", "http://127.0.0.1:53682/dropbox/callback", "")
	assert.Error(t, err, "a sign-in must be bound to a browser")
}
