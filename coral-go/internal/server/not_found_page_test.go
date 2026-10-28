package server

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A browser that asks for a page that is not here gets a 404 page with a way back (#10281); the API, the sockets, auth and the static files keep the plain 404.
func TestNotFoundPageHasTheWayBack(t *testing.T) {
	_, ts, _ := strictServer(t, false)
	get := func(method, path, accept string) (*http.Response, string) {
		req, err := http.NewRequest(method, ts.URL+path, nil)
		require.NoError(t, err)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}
	resp, body := get("GET", "/random-10281", "text/html,application/xhtml+xml")
	assert.Equal(t, 404, resp.StatusCode)
	assert.True(t, strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"))
	assert.Contains(t, body, `<a href="/agents">Back to Agents</a>`)
	assert.NotContains(t, body, "random-10281", "the page names nothing of the request")
	assert.Contains(t, resp.Header.Get("Content-Security-Policy"), "default-src 'none'")

	for _, p := range []string{"/api/nope-10281", "/ws/nope", "/auth/nope", "/static/missing-10281.js"} {
		resp, body := get("GET", p, "text/html")
		assert.Equal(t, 404, resp.StatusCode, p)
		assert.NotContains(t, body, "Back to Agents", "%s keeps the plain 404", p)
	}
	resp, body = get("GET", "/random-10281", "application/json")
	assert.Equal(t, 404, resp.StatusCode)
	assert.NotContains(t, body, "Back to Agents", "a client that does not ask for HTML gets the plain 404")
	resp, body = get("POST", "/random-10281", "text/html")
	assert.NotContains(t, body, "Back to Agents", "only a GET gets the page")
	_ = resp
}
