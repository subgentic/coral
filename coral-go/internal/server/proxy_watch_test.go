package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #21527: a proxied request while remote access is off is noted for the warning and never refused or changed.
func TestWatchForProxyNotesAndNeverRefuses(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	cfg.Host = "127.0.0.1"
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	auth.ResetProxySeenForTest()
	t.Cleanup(auth.ResetProxySeenForTest)

	reached := false
	h := srv.watchForProxy(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(http.StatusTeapot) }))
	do := func(host string, hdr map[string]string) int {
		r := httptest.NewRequest("GET", "/api/anything", nil)
		r.Host = host
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	assert.Equal(t, http.StatusTeapot, do("127.0.0.1:8420", nil))
	assert.False(t, auth.ProxySeen(), "a direct local request is no proxy")

	assert.Equal(t, http.StatusTeapot, do("127.0.0.1:8420", map[string]string{"X-Forwarded-For": "203.0.113.9"}), "the request is passed on unchanged")
	assert.True(t, reached)
	assert.True(t, auth.ProxySeen())

	auth.ResetProxySeenForTest()
	assert.Equal(t, http.StatusTeapot, do("coral.example.com", nil))
	assert.True(t, auth.ProxySeen(), "a public Host name counts too")

	auth.ResetProxySeenForTest()
	srv.cfg.Host = "0.0.0.0"
	do("coral.example.com", map[string]string{"X-Forwarded-For": "203.0.113.9"})
	assert.False(t, auth.ProxySeen(), "remote access on: nothing to warn about")
}
