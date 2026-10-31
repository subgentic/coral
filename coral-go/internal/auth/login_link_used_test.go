package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9961 (the beta tester, on a phone): a used or expired sign-in link was a bare line of monospace text on a
// black page. It is the sign-in page's own look: a card with the Coral mark, what happened, the one command that
// fixes it, and the way to the sign-in page. The 403, the no-store and the page's script policy stay.
func TestUsedLoginLinkIsAPage(t *testing.T) {
	ks, err := NewKeyStore(t.TempDir())
	require.NoError(t, err)
	h := Middleware(ks)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) }))
	r := httptest.NewRequest("GET", "/?login_token=made-up", nil)
	r.RemoteAddr = "127.0.0.1:1"
	r.Host = "localhost:8420"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	assert.Equal(t, authPageCSP, rec.Header().Get("Content-Security-Policy"))
	body := rec.Body.String()
	for _, want := range []string{"<title>This sign-in link has been used", `name="viewport"`, "/static/css/variables.css", "/static/css/base.css", `class="card"`, "coral open", "works once", `href="/auth"`} {
		assert.Contains(t, body, want)
	}
	assert.False(t, strings.Contains(body, "<script>"), "no inline script")
	assert.NotContains(t, body, "made-up", "the token is never echoed")
}

// #11463 F5 (coral-hub's walk): a link refused because ANOTHER USER of this computer opened it (Coral run as root, a browser tunnel arriving as another user) said "has been used", and `coral open` seemed not to
// help. It has its own page that names the cause and the fix. The peer check runs BEFORE the link is looked at, so the page is the same for a real link and a made-up one: it says nothing about the token. A
// used or expired link keeps #9961's page, and a real link still works for the right user afterwards.
func TestLinkOpenedByAnotherUserHasItsOwnPageThatSaysNothingAboutTheToken(t *testing.T) {
	ks, err := NewKeyStore(t.TempDir())
	require.NoError(t, err)
	ks.peerUser = func(*http.Request) (same, supported bool) { return false, true }
	h := Middleware(ks)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) }))
	get := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/?login_token="+token, nil)
		r.RemoteAddr = "127.0.0.1:1"
		r.Host = "localhost:8420"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}
	real, err := ks.MintLoginToken()
	require.NoError(t, err)
	a, b := get(real), get("made-up-token")
	for _, rec := range []*httptest.ResponseRecorder{a, b} {
		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, authPageCSP, rec.Header().Get("Content-Security-Policy"))
		body := rec.Body.String()
		assert.Contains(t, body, "<title>This sign-in link was opened by a different user")
		assert.Contains(t, body, "the user that runs Coral")
		assert.Contains(t, body, "coral open")
		assert.NotContains(t, body, "has been used", "it is not about the link having been used")
		assert.NotContains(t, body, real, "the token is never echoed")
		assert.False(t, strings.Contains(body, "<script>"))
	}
	assert.Equal(t, a.Body.String(), b.Body.String(), "a real link and a made-up one get the same page: nothing is said about the token")

	// the link was not used up by that refusal: the right user (same account) still signs in with it, and then it IS used
	ks.peerUser = func(*http.Request) (same, supported bool) { return true, true }
	ok := get(real)
	assert.Contains(t, []int{http.StatusFound, http.StatusSeeOther}, ok.Code, "the right user signs in with the link the other user was refused")
	assert.NotContains(t, ok.Body.String(), "different user")
	again := get(real)
	assert.Equal(t, http.StatusForbidden, again.Code)
	assert.Contains(t, again.Body.String(), "has been used", "once used it says so, as before (#9961)")
}
