package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10431: a browser whose session another browser ended with "Sign out other browsers" is told why on the sign-in page; a browser that never had a session, one signed out
// by itself and one still signed in are not; the list is bounded.
func TestSignedOutBrowserIsToldWhyOnTheSignInPage(t *testing.T) {
	g := newPwRig(t)
	g.setPassword("a good password for this test")
	browser := func() *http.Cookie {
		tok, err := g.ks.NewSession(httptest.NewRequest("GET", "/", nil), SessionByPassword, false)
		require.NoError(t, err)
		return &http.Cookie{Name: g.ks.cookieBase, Value: tok}
	}
	page := func(c *http.Cookie) string {
		w := httptest.NewRecorder()
		g.ar.AuthPage(w, g.req("GET", "/auth", "", "10.0.0.5", c))
		return w.Body.String()
	}
	me, other, loggedOut := browser(), browser(), browser()
	g.ks.RevokeSession(loggedOut.Value) // its own sign out: no reason shown

	w, _ := g.do(g.ar.SignOutOthers, g.req("POST", "/api/auth/sessions/sign-out-others", "", "10.0.0.5", me))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	assert.Contains(t, page(other), `id="signed-out-why"`, "the browser that was signed out is told why")
	assert.Contains(t, page(other), "Another browser chose Sign out other browsers")
	assert.NotContains(t, page(nil), "signed-out-why", "a browser with no session sees no reason")
	assert.NotContains(t, page(loggedOut), "signed-out-why", "a browser that signed itself out sees no reason")
	assert.NotContains(t, page(&http.Cookie{Name: g.ks.cookieBase, Value: "not-a-session"}), "signed-out-why", "an unknown cookie sees no reason")
	assert.NotContains(t, page(me), "signed-out-why", "the browser that stayed signed in does not")

	// bounded: past the cap the oldest entry goes, and the count never exceeds it
	for i := 0; i < signedOutMax+10; i++ {
		g.ks.noteSignedOut(sessionHash("session-" + string(rune('a'+i%26)) + string(rune('A'+(i/26)%26)) + string(rune('0'+(i/676)%10))))
	}
	g.ks.mu.RLock()
	n := len(g.ks.signedOut)
	g.ks.mu.RUnlock()
	assert.LessOrEqual(t, n, signedOutMax)
}

// #10431: the first password is created without a setup code only by the person at this computer: a loopback peer that names a foreign Host (a DNS-rebinding page) needs the code too.
func TestFirstPasswordNeedsTheCodeForAForeignHostOnLoopback(t *testing.T) {
	g := newPwRig(t)
	g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })
	r := g.req("POST", "/auth/password/create", `{"password":"pw"}`, "127.0.0.1", nil)
	r.Host = "rebind.example.com:8420"
	r.Header.Set("Origin", "http://"+r.Host)
	w, out := g.do(g.ar.CreatePassword, r)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Equal(t, "bad_code", out["code"])
	assert.False(t, g.ks.PasswordSet())
}
