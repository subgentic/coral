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

	// No session: the page stays, whatever the password state.
	w, _ = g.do(g.ar.AuthPage, g.req("GET", "/auth", "", "10.0.0.5", nil))
	assert.Equal(t, http.StatusOK, w.Code)
}

// #15355 (Security's design on #15351, point 1): after "Set password" in the dashboard's box the same browser stays signed in (nothing signs it out, no cookie changes, no page loads).
func TestSettingTheFirstPasswordFromTheDashboardKeepsTheSession(t *testing.T) {
	g := newPwRig(t)
	tok, err := g.ks.NewSession(g.req("GET", "/", "", "10.0.0.5", nil), SessionByLink, false)
	require.NoError(t, err)
	me := &http.Cookie{Name: g.ks.cookieBase, Value: tok}
	w, _ := g.do(g.ar.SetPassword, g.req("POST", "/api/auth/password/set", `{"password":"a-first-password-1"}`, "10.0.0.5", me))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.True(t, g.ks.ValidateSession(tok), "the session the person set the password with is still good")
	assert.Empty(t, w.Result().Cookies(), "no new session and no cookie change: nothing signs the browser out")
}
