package routes

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gdocsync"
)

// #20212: Share to Google used the macOS keychain reader, so a person who signed in through Settings (the sealed in-app sign-in) still got "not signed in".

type authSeen struct {
	mu   sync.Mutex
	auth []string
}

func (a *authSeen) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		a.auth = append(a.auth, r.Header.Get("Authorization"))
		a.mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

func TestShareWorksAfterTheSealedInAppSignIn(t *testing.T) {
	g := newGdocRig(t, true)
	e := newGoogleEnv(t, goodClient)
	seen := &authSeen{}
	ds := httptest.NewServer(seen.wrap(g.drive))
	t.Cleanup(ds.Close)
	oldClient, oldConn, oldSrc := gdocClientFor, gdocConnected, gdocTokenSource
	t.Cleanup(func() { gdocClientFor, gdocConnected, gdocTokenSource = oldClient, oldConn, oldSrc })
	// what the server does at start: the sealed sign-in is the token source and the connected check
	WireGdocGoogle(e.h)
	// the real client, the real token source; only the Drive address is the stand-in's
	gdocClientFor = func() (*gdocsync.Client, error) { return gdocsync.NewClientAt(ds.URL, gdocTokenSource), nil }
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nShip it.\n")

	status, _, raw := g.share(t, gdocV1)
	require.Equal(t, http.StatusBadGateway, status, "before signing in, Share says it is not signed in: "+raw)
	assert.False(t, gdocConnected(), "not connected before the sign-in")

	assert.Contains(t, e.signIn(), "Connected")
	assert.True(t, gdocConnected(), "connected after the sign-in, with nothing in the keychain")
	status, out, raw := g.share(t, gdocV1)
	require.Equal(t, http.StatusOK, status, raw)
	assert.Equal(t, true, out["created"])
	seen.mu.Lock()
	defer seen.mu.Unlock()
	require.NotEmpty(t, seen.auth)
	for _, a := range seen.auth {
		assert.Equal(t, "Bearer acc-1", a, "Drive is called with the sealed sign-in's access token")
	}
}
