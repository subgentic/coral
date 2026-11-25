package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #21220: a self-hosted Hub on another computer sends its request key alone. The middleware lets it on to the identity layer (which checks it) as MethodLinkKey, never as the API key or a session; with the
// API key or a session cookie beside it, it is judged as those are. An address that sent too many wrong keys (API keys or request keys, RecordLinkKeyFailure) is throttled before anything else.
func TestARequestKeySentAloneGoesOnToTheIdentityLayer(t *testing.T) {
	ks := newTestKeyStore(t)
	var got Method
	reached := false
	h := Middleware(ks)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached, got = true, MethodFrom(r.Context()) }))
	serve := func(remote string, mod func(*http.Request)) int {
		reached, got = false, MethodNone
		r := httptest.NewRequest("GET", "/api/health", nil)
		r.RemoteAddr = remote
		r.Host = "coral.example.test:8420"
		if mod != nil {
			mod(r)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}
	withKey := func(r *http.Request) { r.Header.Set(LinkKeyHeader, "lrk_00000000_"+"00000000000000000000000000000000") }

	serve("100.64.0.9:5000", withKey)
	assert.True(t, reached)
	assert.Equal(t, MethodLinkKey, got)

	assert.Equal(t, http.StatusUnauthorized, serve("100.64.0.9:5000", nil), "no credential at all is refused as before")
	assert.False(t, reached)

	serve("100.64.0.9:5000", func(r *http.Request) { withKey(r); r.Header.Set("Authorization", "Bearer "+ks.Key()) })
	assert.Equal(t, MethodAPIKey, got, "beside the API key it is the API key's request (the identity layer refuses the pair)")

	// wrong keys from one address: throttled here, before the identity layer
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "100.64.0.10:5000"
	for i := 0; i < 50; i++ {
		ks.RecordLinkKeyFailure(r)
	}
	assert.Equal(t, http.StatusTooManyRequests, serve("100.64.0.10:5000", withKey))
	assert.False(t, reached)
	serve("100.64.0.11:5000", withKey)
	assert.True(t, reached, "another address is not throttled")
}
