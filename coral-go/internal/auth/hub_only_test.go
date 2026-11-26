package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func hubOnlyHandler(authentic bool) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	return HubOnlyGate(
		func(r *http.Request) bool { return authentic && r.Header.Get("X-Coral-Via") == "secret" },
		func(r *http.Request) bool { return r.Header.Get("X-Coral-Via") != "" },
	)(ok)
}

func hubOnlyDo(h http.Handler, host string, hdr map[string]string, accept string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", "/api/anything", nil)
	r.Host = host
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// #21558: in hub-only mode a proxied request or a non-local Host is refused, with or without a password, a tunnel request and a local one pass, and off changes nothing.
func TestHubOnlyGate(t *testing.T) {
	t.Cleanup(func() { SetHubOnly(false) })
	h := hubOnlyHandler(true)

	SetHubOnly(false)
	assert.Equal(t, http.StatusNoContent, hubOnlyDo(h, "coral.example.com", map[string]string{"X-Forwarded-For": "203.0.113.9"}, "").Code, "off: nothing is refused")

	SetHubOnly(true)
	for name, tc := range map[string]struct {
		host string
		hdr  map[string]string
	}{
		"x-forwarded-for":  {"127.0.0.1:8420", map[string]string{"X-Forwarded-For": "203.0.113.9"}},
		"x-forwarded-host": {"127.0.0.1:8420", map[string]string{"X-Forwarded-Host": "coral.example.com"}},
		"forwarded":        {"127.0.0.1:8420", map[string]string{"Forwarded": "for=203.0.113.9"}},
		"via":              {"127.0.0.1:8420", map[string]string{"Via": "1.1 proxy"}},
		"x-real-ip":        {"127.0.0.1:8420", map[string]string{"X-Real-Ip": "203.0.113.9"}},
		"public host":      {"coral.example.com", nil},
		"lan host":         {"192.168.1.5:8420", nil},
		"forged stamp":     {"127.0.0.1:8420", map[string]string{"X-Coral-Via": "guess"}},
	} {
		w := hubOnlyDo(h, tc.host, tc.hdr, "")
		assert.Equal(t, http.StatusForbidden, w.Code, name)
		assert.Contains(t, w.Body.String(), `"error_code":"hub_only"`, name)
	}
	page := hubOnlyDo(h, "coral.example.com", nil, "text/html,application/xhtml+xml")
	assert.Equal(t, http.StatusForbidden, page.Code)
	assert.Contains(t, page.Header().Get("Content-Type"), "text/html")
	assert.Contains(t, page.Body.String(), "Coral Hub only")

	assert.Equal(t, http.StatusNoContent, hubOnlyDo(h, "127.0.0.1:8420", nil, "").Code, "a local client (the command line, the hooks) passes")
	assert.Equal(t, http.StatusNoContent, hubOnlyDo(h, "localhost:8420", nil, "").Code)
	assert.Equal(t, http.StatusNoContent, hubOnlyDo(h, "coral.example.com", map[string]string{"X-Forwarded-For": "203.0.113.9", "X-Coral-Via": "secret"}, "").Code, "a request Coral Hub's connector forwarded passes")
}

func TestHubOnlyMarkerIsPersistedAndRemoved(t *testing.T) {
	dir := t.TempDir()
	assert.False(t, HubOnlyPersisted(dir))
	require.NoError(t, SetHubOnlyPersisted(dir, true))
	assert.True(t, HubOnlyPersisted(dir))
	require.NoError(t, SetHubOnlyPersisted(dir, false))
	assert.False(t, HubOnlyPersisted(dir))
	require.NoError(t, SetHubOnlyPersisted(dir, false), "off twice is fine")
}
