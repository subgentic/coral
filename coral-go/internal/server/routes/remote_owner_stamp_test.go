package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

type ownerResolver struct{ target proxy.HTTPTarget }

// remoteStampTestKey is the remote API key of these tests: a plain constant, not a key-shaped literal.
const remoteStampTestKey = "not-a-real-key-for-tests"

func (o ownerResolver) Resolve(context.Context, string) (proxy.Target, error) { return o.target, nil }

// A hub's own identity layer decides who is the person: its dashboard session (or this computer's same-origin browser) is, an API key (a script) and an agent token are not. Only the person's decision is
// signed (#11378), through the real observer and the real mount.
func TestOnlyThePersonSignedInAtTheHubHasTheirDecisionSigned(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	var mu sync.Mutex
	var stamp string
	rem := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		mu.Lock()
		stamp = r.Header.Get(hubowner.Header)
		mu.Unlock()
	}))
	t.Cleanup(rem.Close)

	cookie := false
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return cookie })
	o.SetVerifiers(func(*http.Request) bool { return true }, nil)
	r := chi.NewRouter()
	r.Use(o.Middleware)
	target := proxy.HTTPTarget{URL: rem.URL, AllowPrivate: true, OwnerSecret: strings.Repeat("ab", 32), RemoteID: "ssh-box"}
	target.APIKey = remoteStampTestKey // set apart from the literal: internal/secrets' header-key rule reads a "name: value" shape in the repository's own text as a key
	MountRemoteProxy(r, ownerResolver{target})
	hub := httptest.NewServer(r)
	t.Cleanup(hub.Close)

	send := func(mutate func(*http.Request)) string {
		req, _ := http.NewRequest("POST", hub.URL+"/api/remote/ssh-box/api/board/team/artifacts/abc/review", strings.NewReader(`{"decision":"approve"}`))
		req.Header.Set("Content-Type", "application/json")
		mutate(req)
		mu.Lock()
		stamp = ""
		mu.Unlock()
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		mu.Lock()
		defer mu.Unlock()
		return stamp
	}

	// a script with the hub's API key: not a person
	assert.Empty(t, send(func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-key") }), "a script's request was signed")
	// an agent token: not a person
	tok, err := db.MintSessionToken(context.Background(), "sid-agent", "claude-agent")
	require.NoError(t, err)
	assert.Empty(t, send(func(r *http.Request) { r.Header.Set("X-Coral-Session-Token", tok) }), "an agent's request was signed")
	// the signed-in dashboard: a person
	cookie = true
	assert.NotEmpty(t, send(func(r *http.Request) {}), "the signed-in person's decision was not signed")
	cookie = false
	// this computer's own browser (same-origin fetch, no cookie): a person
	assert.NotEmpty(t, send(func(r *http.Request) {
		r.Header.Set("Origin", hub.URL)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}), "this computer's own browser was not signed")
	// a browser's forged stamp on the API-key path is not carried
	assert.Empty(t, send(func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-key")
		r.Header.Set(hubowner.Header, "v1.1.00000000000000000000000000000000."+strings.Repeat("0", 64))
	}))
}

// #13725 through the real observer and the real mount: a WIDENED route (#13694, generation 2) is signed for the person who holds a sign-in SESSION (the dashboard cookie) and not for this computer's own browser with
// sign-in off, and only for a remote whose health says it accepts generation 2.
func TestAWidenedClickIsSignedOnlyForASignInSessionAndARemoteThatAcceptsIt(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	var mu sync.Mutex
	var stamp string
	remoteGen := 2
	rem := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		if r.URL.Path == "/api/health" {
			mu.Lock()
			g := remoteGen
			mu.Unlock()
			_, _ = io.WriteString(w, `{"status":"ok","hub_owner_routes":`+string(rune('0'+g))+`}`)
			return
		}
		mu.Lock()
		stamp = r.Header.Get(hubowner.Header)
		mu.Unlock()
	}))
	t.Cleanup(rem.Close)
	cookie := false
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return cookie })
	o.SetVerifiers(func(*http.Request) bool { return true }, nil)
	r := chi.NewRouter()
	r.Use(o.Middleware)
	target := proxy.HTTPTarget{URL: rem.URL, AllowPrivate: true, OwnerSecret: strings.Repeat("ab", 32), RemoteID: "ssh-box"}
	target.APIKey = remoteStampTestKey
	MountRemoteProxy(r, ownerResolver{target})
	hub := httptest.NewServer(r)
	t.Cleanup(hub.Close)
	send := func(mutate func(*http.Request)) string {
		req, _ := http.NewRequest("POST", hub.URL+"/api/remote/ssh-box/api/board/team/tasks/5/complete", strings.NewReader(`{"note":"done"}`))
		req.Header.Set("Content-Type", "application/json")
		mutate(req)
		mu.Lock()
		stamp = ""
		mu.Unlock()
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		mu.Lock()
		defer mu.Unlock()
		return stamp
	}
	cookie = true
	assert.NotEmpty(t, send(func(r *http.Request) {}), "a sign-in session's widened click was not signed")
	cookie = false
	assert.Empty(t, send(func(r *http.Request) {
		r.Header.Set("Origin", hub.URL)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}), "this computer's own browser (sign-in off) had a widened click signed")
	assert.Empty(t, send(func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-key") }), "a script's widened click was signed")
}

// #13725 (Security's INFO 7): the widened routes carry deletes and goal edits on the dashboard cookie, so a page on ANOTHER SITE that rides a valid cookie must be refused at the hub by the global foreign-origin guard
// (#3511, the real ForeignBrowserWrites ahead of the identity layer and the mount, as router.go orders them) and never reach the remote: not the click, not the generation read, not a stamp.
func TestACrossSitePageRidingASignInCookieIsRefusedAtTheHubAndNothingIsSigned(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	var mu sync.Mutex
	var stamp string
	reached := 0
	rem := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		mu.Lock()
		reached++
		if r.URL.Path != "/api/health" {
			stamp = r.Header.Get(hubowner.Header)
		}
		mu.Unlock()
		if r.URL.Path == "/api/health" {
			_, _ = io.WriteString(w, `{"status":"ok","hub_owner_routes":2}`)
		}
	}))
	t.Cleanup(rem.Close)
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return true }) // every request holds a valid sign-in cookie
	o.SetVerifiers(func(*http.Request) bool { return true }, nil)
	r := chi.NewRouter()
	r.Use(ForeignBrowserWrites(nil))
	r.Use(o.Middleware)
	target := proxy.HTTPTarget{URL: rem.URL, AllowPrivate: true, OwnerSecret: strings.Repeat("ab", 32), RemoteID: "ssh-box"}
	target.APIKey = remoteStampTestKey
	MountRemoteProxy(r, ownerResolver{target})
	hub := httptest.NewServer(r)
	t.Cleanup(hub.Close)
	send := func(mutate func(*http.Request)) (int, string) {
		req, _ := http.NewRequest("POST", hub.URL+"/api/remote/ssh-box/api/board/team/tasks/5/complete", strings.NewReader(`{"note":"done"}`))
		req.Header.Set("Content-Type", "application/json")
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}
	for name, mutate := range map[string]func(*http.Request){
		"another site's Origin":    func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
		"Sec-Fetch-Site":           func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"a repeated Origin header": func(r *http.Request) { r.Header.Add("Origin", hub.URL); r.Header.Add("Origin", "http://evil.example") },
	} {
		code, body := send(mutate)
		assert.Equal(t, http.StatusForbidden, code, name)
		assert.Contains(t, body, "foreign_origin", name)
	}
	mu.Lock()
	assert.Zero(t, reached, "the remote was not reached at all: no click, no generation read")
	assert.Empty(t, stamp, "nothing was signed")
	mu.Unlock()
	// the page's own origin with the same cookie: signed
	code, _ := send(func(r *http.Request) { r.Header.Set("Origin", hub.URL); r.Header.Set("Sec-Fetch-Site", "same-origin") })
	assert.Equal(t, http.StatusOK, code)
	mu.Lock()
	assert.NotEmpty(t, stamp, "the dashboard's own page was signed")
	mu.Unlock()
}
