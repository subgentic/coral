package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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
	// The one trace such a sign-in leaves: Settings > Sessions shows it as opened on this computer. An ordinary link's session is not labelled so.
	ordinary, err := g.ks.MintLoginToken()
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	require.True(t, g.ks.handleLoginToken(rec, g.req("GET", "/?"+LoginTokenParam+"="+ordinary, "", "127.0.0.1", nil)))
	list, err := g.ks.backend().ListSessions(t.Context())
	require.NoError(t, err)
	local, plain := 0, 0
	for _, s := range list {
		if strings.HasPrefix(s.Label, LocalSessionLabelPrefix) {
			local++
		} else {
			plain++
		}
	}
	assert.Equal(t, 1, local, "the button's session is labelled")
	assert.Equal(t, 1, plain, "an ordinary link's session is not")
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

// #12834, QA Reviewer 2's MUST: the button's note is shared by the create page and the sign-in page. Only the create page (no password yet) says Coral asks for a password next; a page for a computer that has one
// never promises that. (The server offers the button only while no password is set, so the sign-in rendering is the template's own rule, pinned here.)
func TestTheOpenOnThisComputerNoteSaysThePasswordPromptOnlyWhereItIsTrue(t *testing.T) {
	create := AuthPage(PageState{Local: true, LocalOpen: true})
	assert.Contains(t, create, "Coral then asks you to create a password")
	signIn := AuthPage(PageState{Local: true, LocalOpen: true, PasswordSet: true})
	require.Contains(t, signIn, "so it can open Coral from here.")
	assert.NotContains(t, signIn, "asks you to create a password", "a computer that already has a password is never told it will be asked for one")
	assert.NotContains(t, strings.ToLower(signIn), "without a password")
}

// The page shows the button only to a browser on this computer, in both its states.
func TestTheSignInPageOffersOpenOnThisComputerOnlyLocally(t *testing.T) {
	page := AuthPage(PageState{Local: true, LocalOpen: true})
	assert.Contains(t, page, `action="/auth/local"`)
	assert.Contains(t, page, "Open Coral on this computer")
	assert.Equal(t, 1, strings.Count(page, `id="local-open"`))
	// #12834: the words match what happens next. The dashboard asks for a password at once (a password is always created, #11892), so the page says so and never promises a way in without one.
	assert.Contains(t, page, "Coral then asks you to create a password")
	assert.NotContains(t, strings.ToLower(page), "without a password", "the button's note no longer promises what the next screen takes back")
	for _, s := range []PageState{{PasswordSet: true, Local: true}, {Local: true}, {PasswordSet: true}, {}} {
		assert.NotContains(t, AuthPage(s), "/auth/local", "offered only when the server says so (this computer, no password yet)")
	}
}

// The operator's choice (#289): only while no password is set, by a positive answer. A set password, or a password file that cannot be read,
// means no button on the page and a 403 from the route; no link is made.
func TestOpenCoralOnThisComputerOnlyWhileNoPasswordIsSet(t *testing.T) {
	for name, prep := range map[string]func(g *pwRig){
		"a password is set": func(g *pwRig) { g.setPassword("correct horse") },
		"the file cannot be read": func(g *pwRig) {
			require.NoError(t, os.Mkdir(filepath.Join(g.ks.dataDir(), PasswordFile), 0o700)) // a folder where the file should be: there, but not readable as a password
		},
		"the file is empty": func(g *pwRig) {
			require.NoError(t, os.WriteFile(filepath.Join(g.ks.dataDir(), PasswordFile), nil, 0o600))
		},
	} {
		t.Run(name, func(t *testing.T) {
			g := newPwRig(t)
			g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })
			prep(g)
			assert.False(t, g.ar.LocalOpenOffered(g.req("GET", "/auth", "", "127.0.0.1", nil)), "no button")
			w, out := g.do(g.ar.LocalOpen, g.req("POST", LocalOpenPath, "", "127.0.0.1", nil))
			assert.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
			assert.Equal(t, "password_set", out["code"])
			g.ks.mu.Lock()
			made := len(g.ks.loginTokens)
			g.ks.mu.Unlock()
			assert.Zero(t, made, "no link was made")
		})
	}
	g := newPwRig(t)
	g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })
	assert.True(t, g.ar.LocalOpenOffered(g.req("GET", "/auth", "", "127.0.0.1", nil)), "no file at all: offered")
	assert.False(t, g.ar.LocalOpenOffered(g.req("GET", "/auth", "", "10.0.0.5", nil)), "never to another computer")
}

// An Lstat error other than "does not exist" on the password file (access denied on its folder, here through the seam) is not "no password":
// no button, and the route refuses without making a link.
func TestALstatErrorOnThePasswordFileIsNotNoPassword(t *testing.T) {
	g := newPwRig(t)
	g.ar.SetPeerUser(func(*http.Request) (bool, bool) { return true, true })
	prev := passwordLstat
	passwordLstat = func(string) (os.FileInfo, error) {
		return nil, &os.PathError{Op: "lstat", Path: "password", Err: os.ErrPermission}
	}
	t.Cleanup(func() { passwordLstat = prev })

	assert.Equal(t, passwordUnreadable, g.ks.passwordState())
	assert.False(t, g.ar.LocalOpenOffered(g.req("GET", "/auth", "", "127.0.0.1", nil)), "no button")
	w, out := g.do(g.ar.LocalOpen, g.req("POST", LocalOpenPath, "", "127.0.0.1", nil))
	assert.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	assert.Equal(t, "password_set", out["code"])
	g.ks.mu.Lock()
	made := len(g.ks.loginTokens)
	g.ks.mu.Unlock()
	assert.Zero(t, made, "no link was made")
}
