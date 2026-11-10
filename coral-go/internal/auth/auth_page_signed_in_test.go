package auth

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15237 (Beta walk 6 M13, #15227): a browser signed in by a link, with no password yet, got the dashboard's "Protect Coral with a password" box AND this page's "Create a password". The page is for a browser with no session.
func TestAuthPageSendsASignedInBrowserWithNoPasswordBackToTheDashboard(t *testing.T) {
	g := newPwRig(t)
	tok, err := g.ks.NewSession(g.req("GET", "/", "", "10.0.0.5", nil), SessionByLink, false)
	require.NoError(t, err)
	me := &http.Cookie{Name: g.ks.cookieBase, Value: tok}

	w, _ := g.do(g.ar.AuthPage, g.req("GET", "/auth?locked=1&return_to=%2Finbox", "", "10.0.0.5", me))
	assert.Equal(t, http.StatusSeeOther, w.Code)
	assert.Equal(t, "/inbox", w.Header().Get("Location"))
	w, _ = g.do(g.ar.AuthPage, g.req("GET", "/auth?return_to=https%3A%2F%2Fevil.example", "", "10.0.0.5", me))
	assert.Equal(t, "/", w.Header().Get("Location"), "never off this site")

	w, _ = g.do(g.ar.AuthPage, g.req("GET", "/auth?return_to=%2Fauth%3Flocked%3D1", "", "10.0.0.5", me))
	assert.Equal(t, "/", w.Header().Get("Location"), "never back to the page itself: it would loop")

	// No session: the page stays, whatever the password state.
	w, _ = g.do(g.ar.AuthPage, g.req("GET", "/auth", "", "10.0.0.5", nil))
	assert.Equal(t, http.StatusOK, w.Code)
}
