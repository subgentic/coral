package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
