package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #3682 (finding 4): every /api/ and /ws response is no-store unless its handler chooses
// otherwise; the page itself is untouched.
func TestAPIResponsesAreNotStored(t *testing.T) {
	h := noStoreAPI(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/artifacts/x" {
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable") // its own choice
		}
	}))
	for path, want := range map[string]string{
		"/api/health": "no-store", "/api/board/team/messages": "no-store", "/ws/coral": "no-store",
		"/api/artifacts/x": "private, max-age=31536000, immutable", "/": "", "/static/app.js": "",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		assert.Equal(t, want, rec.Header().Get("Cache-Control"), path)
	}
}

// The QR code can encode a sign-in link: never kept.
func TestQRCodeIsNotStored(t *testing.T) {
	r := newE2ERemote(t, "qr", nil)
	req := httptest.NewRequest("GET", "/api/system/qr?url=http%3A%2F%2F127.0.0.1%3A8420%2F", nil)
	req.RemoteAddr, req.Host = "127.0.0.1:50000", "127.0.0.1:8420"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec := httptest.NewRecorder()
	r.srv.Router().ServeHTTP(rec, req)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"), "status %d", rec.Code)
}

// #21544: nosniff is on every answer, not only /api/: the /auth pages, the shell, static files and a missing path.
func TestEveryAnswerIsNosniff(t *testing.T) {
	h := noStoreAPI(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for _, path := range []string{"/api/health", "/ws/coral", "/auth", "/auth/link", "/", "/static/app.js", "/no/such/page"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"), path)
	}
	r := newE2ERemote(t, "nosniff", nil) // and through the real router, where a handler of its own could drop it
	for _, path := range []string{"/auth", "/no/such/page"} {
		req := httptest.NewRequest("GET", path, nil)
		req.RemoteAddr, req.Host = "127.0.0.1:50000", "127.0.0.1:8420"
		rec := httptest.NewRecorder()
		r.srv.Router().ServeHTTP(rec, req)
		assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"), "%s status %d", path, rec.Code)
	}
}
