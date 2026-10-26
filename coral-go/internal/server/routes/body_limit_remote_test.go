package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
)

// #8725: through a hub, the image upload to another computer (POST /api/remote/{server}/api/upload) takes the upload route's own limit: the catch-all gave it the default 8 MiB, so a 19 MB screenshot
// was answered 413 body_too_large at the hub while the computer itself would take it. Every other request through the proxy keeps the default.
func TestRemoteUploadThroughTheHubTakesTheUploadLimit(t *testing.T) {
	var limit int64
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
			limit = bodyLimitFor(q)
			next.ServeHTTP(w, q)
		})
	})
	r.Handle("/api/remote/{server}/*", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for _, c := range []struct {
		method, path string
		want         int64
	}{
		{http.MethodPost, "/api/remote/box-2/api/upload", bodyLimits["POST /api/upload"]},
		{http.MethodPost, "/api/remote/box-2/api/upload/", defaultBodyLimit},
		{http.MethodPost, "/api/remote/box-2/api/upload/x.png", defaultBodyLimit},
		{http.MethodPost, "/api/remote/box-2/api/uploads", defaultBodyLimit},
		{http.MethodPost, "/api/remote/box-2/api/tags", defaultBodyLimit},
		{http.MethodPut, "/api/remote/box-2/api/upload", defaultBodyLimit},
	} {
		limit = 0
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(c.method, "http://x"+c.path, nil))
		assert.Equal(t, c.want, limit, "%s %s", c.method, c.path)
	}
	assert.Greater(t, bodyLimits["POST /api/upload"], int64(defaultBodyLimit), "the upload limit is the raised one")
}
