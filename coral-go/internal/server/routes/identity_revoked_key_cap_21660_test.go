package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// A revoked request key is refused 401 and not counted as a wrong key, but one address gets only revokedKeyCap of them a minute, then a 429 that is the JSON error envelope (#21660). The cap is its own: it
// never adds to the wrong-key count the other Hubs behind the same address share (#21645).
func TestRevokedRequestKeyHasItsOwnCap(t *testing.T) {
	o := NewIdentityObserver(nil, nil, func(*http.Request) bool { return false })
	now := time.Unix(1_700_000_000, 0)
	o.now = func() time.Time { return now }
	wrongCounted := 0
	o.SetLinkKeys(func(context.Context, string) (string, bool) { return "", false })
	o.SetLinkKeyRevoked(func(_ context.Context, key string) bool { return key == "revoked" })
	o.SetLinkKeyFailures(func(*http.Request) { wrongCounted++ })
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("a refused key reached the handler") })
	ask := func(key, addr string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/cloud/link-requests", nil)
		r.RemoteAddr = addr
		r.Header.Set(linkKeyHeader, key)
		w := httptest.NewRecorder()
		o.serveLinkKey(w, r, next, key)
		return w
	}
	for i := 0; i < revokedKeyCap; i++ {
		assert.Equal(t, http.StatusUnauthorized, ask("revoked", "127.0.0.1:5000").Code, "try %d", i+1)
	}
	over := ask("revoked", "127.0.0.1:5001") // another port, the same address
	assert.Equal(t, http.StatusTooManyRequests, over.Code)
	assert.Contains(t, over.Body.String(), `"code":"revoked_key_rate_limited"`, "the JSON error envelope")
	assert.Equal(t, "60", over.Header().Get("Retry-After"))
	assert.Equal(t, "action", over.Header().Get("X-Coral-Limit"), "marked as a per-action limit, not an overload")
	assert.Equal(t, 0, wrongCounted, "revoked keys are never counted as wrong ones")
	assert.Equal(t, http.StatusUnauthorized, ask("revoked", "10.0.0.9:1").Code, "another address has its own cap")
	assert.Equal(t, http.StatusUnauthorized, ask("wrong", "127.0.0.1:5002").Code, "a wrong key is still a 401, counted as before")
	assert.Equal(t, 1, wrongCounted)
	now = now.Add(revokedKeyWindow)
	assert.Equal(t, http.StatusUnauthorized, ask("revoked", "127.0.0.1:5003").Code, "the next minute starts a new window")
}
