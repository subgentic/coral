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
