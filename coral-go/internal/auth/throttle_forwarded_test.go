package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// Behind a reverse proxy on this computer every browser's peer is 127.0.0.1. The wrong-password and wrong-key counts are kept per client the proxy names in X-Forwarded-For (its last value), so a
// stranger's guesses never slow the Operator; a peer that is not a trusted proxy is counted by its own address and its header is not read.
func fwd(peer string, xff ...string) *http.Request {
	r := httptest.NewRequest("POST", "/auth/password", nil)
	r.RemoteAddr = peer + ":5000"
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestTheThrottleAddressIsTheForwardedClientOfATrustedProxyOnly(t *testing.T) {
	ks := newTestKeyStore(t)
	require.NoError(t, ks.SetTrustedProxies("192.168.1.7"))
	for name, c := range map[string]struct {
		r    *http.Request
		want string
	}{
		"loopback proxy, one client":       {fwd("127.0.0.1", "203.0.113.9"), "203.0.113.9"},
		"the last value is the proxy's":    {fwd("127.0.0.1", "6.6.6.6, 203.0.113.9"), "203.0.113.9"},
		"the last of repeated headers":     {fwd("127.0.0.1", "6.6.6.6", "203.0.113.9"), "203.0.113.9"},
		"a listed proxy":                   {fwd("192.168.1.7", "198.51.100.4"), "198.51.100.4"},
		"no header: the peer":              {fwd("127.0.0.1"), "127.0.0.1"},
		"not an address: the peer":         {fwd("127.0.0.1", "unknown"), "127.0.0.1"},
		"a stranger's header is ignored":   {fwd("10.0.0.5", "203.0.113.9"), "10.0.0.5"},
		"a stranger spoofing the Operator": {fwd("198.51.100.77", "127.0.0.1"), "198.51.100.77"},
	} {
		assert.Equal(t, c.want, ks.throttleAddr(c.r), name)
	}
}

func TestTwoForwardedClientsHaveTheirOwnWrongPasswordCount(t *testing.T) {
	g := newPwRig(t)
	g.setPassword("open sesame")
	as := func(client string) *http.Request {
		r := g.req("POST", "/auth/password", `{"password":"nope"}`, "127.0.0.1", nil)
		r.Header.Set("X-Forwarded-For", client)
		return r
	}
	for i := 0; i < freeFails+1; i++ { // the guesser spends its free tries and is made to wait
		g.do(g.ar.SignInWithPassword, as("203.0.113.9"))
	}
	w, _ := g.do(g.ar.SignInWithPassword, as("203.0.113.9"))
	assert.Equal(t, http.StatusTooManyRequests, w.Code, "the guesser waits")
	right := g.req("POST", "/auth/password", `{"password":"open sesame"}`, "127.0.0.1", nil)
	right.Header.Set("X-Forwarded-For", "198.51.100.4")
	w, _ = g.do(g.ar.SignInWithPassword, right)
	assert.Equal(t, http.StatusOK, w.Code, "the Operator, another client behind the same proxy, signs in at once: %s", w.Body.String())
}

func TestASpoofedHeaderFromAnotherComputerChangesNoBucket(t *testing.T) {
	g := newPwRig(t)
	g.setPassword("open sesame")
	for i := 0; i < freeFails+1; i++ { // each wrong guess names a different "client"
		r := g.req("POST", "/auth/password", `{"password":"nope"}`, "10.0.0.5", nil)
		r.Header.Set("X-Forwarded-For", "203.0.113."+string(rune('1'+i)))
		g.do(g.ar.SignInWithPassword, r)
	}
	r := g.req("POST", "/auth/password", `{"password":"nope"}`, "10.0.0.5", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.99")
	w, _ := g.do(g.ar.SignInWithPassword, r)
	assert.Equal(t, http.StatusTooManyRequests, w.Code, "the header did not give it a fresh count")
}

func TestTwoForwardedClientsHaveTheirOwnWrongKeyCount(t *testing.T) {
	ks := newTestKeyStore(t)
	h := Middleware(ks)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	call := func(peer, client, key string) int {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.RemoteAddr = peer + ":5000"
		r.Host = "localhost:8420"
		r.Header.Set("Authorization", "Bearer "+key)
		if client != "" {
			r.Header.Set("X-Forwarded-For", client)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for i := 0; i < rateLimitMax+2; i++ {
		call("127.0.0.1", "203.0.113.9", "wrong-key")
	}
	assert.Equal(t, http.StatusTooManyRequests, call("127.0.0.1", "203.0.113.9", ks.Key()), "the guesser is limited")
	assert.Equal(t, http.StatusOK, call("127.0.0.1", "198.51.100.4", ks.Key()), "another client behind the proxy is not")
	// from a peer that is not a proxy the header changes nothing: one address, one budget
	for i := 0; i < rateLimitMax+2; i++ {
		call("10.0.0.5", "198.51.100."+string(rune('1'+i)), "wrong-key")
	}
	assert.Equal(t, http.StatusTooManyRequests, call("10.0.0.5", "198.51.100.200", ks.Key()))
}

// A proxy that does not overwrite X-Forwarded-For lets a stranger name a new client on every try. Each wrong try is also counted under the proxy's own address, with a ceiling a real set of browsers does
// not reach and a rotating guesser does: 200 wrong passwords with 200 forged values are throttled, and so are 200 wrong keys.
func TestAGuesserRotatingTheForwardedAddressIsStillThrottled(t *testing.T) {
	g := newPwRig(t)
	g.setPassword("open sesame")
	var throttled int
	for i := 0; i < 200; i++ {
		r := g.req("POST", "/auth/password", `{"password":"nope"}`, "127.0.0.1", nil)
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.%d.%d", i/200, i%200+1))
		if w, _ := g.do(g.ar.SignInWithPassword, r); w.Code == http.StatusTooManyRequests {
			throttled++
		}
	}
	assert.Greater(t, throttled, 100, "most of the 200 forged tries were made to wait: %d", throttled)
	right := g.req("POST", "/auth/password", `{"password":"open sesame"}`, "127.0.0.1", nil)
	right.Header.Set("X-Forwarded-For", "198.51.100.4")
	w, _ := g.do(g.ar.SignInWithPassword, right)
	assert.Equal(t, http.StatusTooManyRequests, w.Code, "while a guesser rotates the header, the proxy as a whole waits")
}

func TestARealSetOfBrowsersBehindAProxyIsNotThrottledTogether(t *testing.T) {
	g := newPwRig(t)
	g.setPassword("open sesame")
	for c := 0; c < 8; c++ { // eight people each mistype twice: far under the proxy's ceiling
		for k := 0; k < 2; k++ {
			r := g.req("POST", "/auth/password", `{"password":"nope"}`, "127.0.0.1", nil)
			r.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", c+1))
			g.do(g.ar.SignInWithPassword, r)
		}
	}
	right := g.req("POST", "/auth/password", `{"password":"open sesame"}`, "127.0.0.1", nil)
	right.Header.Set("X-Forwarded-For", "198.51.100.200")
	w, _ := g.do(g.ar.SignInWithPassword, right)
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestWrongKeysWithRotatingForwardedAddressesHitTheProxyCeiling(t *testing.T) {
	ks := newTestKeyStore(t)
	h := Middleware(ks)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	call := func(client, key string) int {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.RemoteAddr = "127.0.0.1:5000"
		r.Host = "localhost:8420"
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("X-Forwarded-For", client)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	limited := 0
	for i := 0; i < 200; i++ {
		if call(fmt.Sprintf("203.0.%d.%d", i/200, i%200+1), "wrong-key") == http.StatusTooManyRequests {
			limited++
		}
	}
	assert.Greater(t, limited, 90, "the 200 forged tries hit the proxy's ceiling (%d of them refused)", limited)
	assert.Equal(t, http.StatusTooManyRequests, call("198.51.100.4", ks.Key()))
}

// A request the Coral Hub connector carried counts under its peer whatever header it has.
func TestTheHubTunnelsRequestsIgnoreForwardedHeaders(t *testing.T) {
	ks := newTestKeyStore(t)
	r := fwd("127.0.0.1", "203.0.113.9")
	r.Header.Set(tunnel.ViaHeader, "stamp")
	assert.Equal(t, "127.0.0.1", ks.throttleAddr(r))
	assert.Equal(t, "", ks.peerThrottleKey(r))
}
