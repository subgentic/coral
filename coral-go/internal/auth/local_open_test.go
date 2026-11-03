package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The sign-in page's "Open Coral on this computer": from this computer, in Coral's own account, the button gives a single-use link that signs
// the browser in through the ordinary link handler; from anywhere else it gives nothing.
func TestOpenCoralOnThisComputerSignsInThroughASingleUseLink(t *testing.T) {
	g := newPwRig(t)
	g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })
	g.ks.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })

	w, _ := g.do(g.ar.LocalOpen, g.req("POST", LocalOpenPath, "", "127.0.0.1", nil))
	require.Equal(t, http.StatusSeeOther, w.Code, w.Body.String())
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	assert.Equal(t, "no-referrer", w.Header().Get("Referrer-Policy"))
	loc, err := url.Parse(w.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "/", loc.Path, "the redirect stays on this server")
	assert.Empty(t, loc.Host)
	token := loc.Query().Get(LoginTokenParam)
	require.NotEmpty(t, token)

	// The browser follows it: the ordinary link handler signs it in, once.
	follow := func() *httptest.ResponseRecorder {
		r := g.req("GET", "/?"+LoginTokenParam+"="+token, "", "127.0.0.1", nil)
		rec := httptest.NewRecorder()
		require.True(t, g.ks.handleLoginToken(rec, r))
		return rec
	}
	first := follow()
	require.Equal(t, http.StatusFound, first.Code, first.Body.String())
	assert.True(t, g.ks.ValidateSession(sessionCookie(t, first).Value))
	second := follow()
	assert.NotEqual(t, http.StatusFound, second.Code, "single use")
}

// Nothing is made for a request that is not this computer in Coral's account, not from Coral's own page, or an agent's.
func TestOpenCoralOnThisComputerRefusesEveryOtherCaller(t *testing.T) {
	type tc struct {
		addr            string
		same, supported bool
		lost            bool
		mutate          func(*http.Request)
		code            string
	}
	cases := map[string]tc{
		"another computer":         {addr: "10.0.0.5", same: true, supported: true, code: "not_this_computer"},
		"a proxy on this computer": {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Header.Set("X-Forwarded-For", "10.0.0.5") }, code: "not_this_computer"},
		"Coral Hub's tunnel":       {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Header.Set("X-Coral-Via-Tunnel", "x") }, code: "not_this_computer"},
		"another account":          {addr: "127.0.0.1", same: false, supported: true, code: "not_this_computer"},
		"a system that can't tell": {addr: "127.0.0.1", same: false, supported: false, code: "not_this_computer"},
		"the peer check lost":      {addr: "127.0.0.1", same: true, supported: true, lost: true, code: "not_this_computer"},
		"a host name not local":    {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Host = "evil.test:8420"; r.Header.Set("Origin", "http://evil.test:8420") }, code: "not_this_computer"},
		"another site": {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) {
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			r.Header.Set("Origin", "https://evil.test")
		}, code: "cross_origin"},
		"another port of localhost": {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) {
			r.Header.Set("Sec-Fetch-Site", "same-site")
			r.Header.Set("Origin", "http://localhost:9999")
		}, code: "cross_origin"},
		"no Sec-Fetch-Site": {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Header.Del("Sec-Fetch-Site") }, code: "cross_origin"},
		"no Origin":         {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Header.Del("Origin") }, code: "cross_origin"},
		"an agent's tool":   {addr: "127.0.0.1", same: true, supported: true, mutate: func(r *http.Request) { r.Header.Set(agentTokenHeader, "an-agent-token") }, code: "forbidden_for_agent"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			g := newPwRig(t)
			same, supported := c.same, c.supported
			g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return same, supported })
			if c.lost {
				peerCheckLost.Store(true)
				t.Cleanup(func() { peerCheckLost.Store(false) })
			}
			r := g.req("POST", LocalOpenPath, "", c.addr, nil)
			if c.mutate != nil {
				c.mutate(r)
			}
			w, out := g.do(g.ar.LocalOpen, r)
			assert.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
			assert.Equal(t, c.code, out["code"])
			assert.Empty(t, w.Header().Get("Location"))
			assert.NotContains(t, w.Body.String(), LoginTokenParam)
			g.ks.mu.Lock()
			made := len(g.ks.loginTokens)
			g.ks.mu.Unlock()
			assert.Zero(t, made, "no link was made")
		})
	}
}

// The page shows the button only to a browser on this computer, in both its states.
func TestTheSignInPageOffersOpenOnThisComputerOnlyLocally(t *testing.T) {
	for _, s := range []PageState{{PasswordSet: true, Local: true}, {Local: true}} {
		page := AuthPage(s)
		assert.Contains(t, page, `action="/auth/local"`)
		assert.Contains(t, page, "Open Coral on this computer")
		assert.Equal(t, 1, strings.Count(page, `id="local-open"`))
	}
	for _, s := range []PageState{{PasswordSet: true}, {}} {
		assert.NotContains(t, AuthPage(s), "/auth/local", "not offered to another computer")
	}
}
