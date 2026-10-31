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
	MountRemoteProxy(r, ownerResolver{proxy.HTTPTarget{URL: rem.URL, APIKey: "remote-key-0123456789", AllowPrivate: true, OwnerSecret: strings.Repeat("ab", 32), RemoteID: "ssh-box"}})
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
