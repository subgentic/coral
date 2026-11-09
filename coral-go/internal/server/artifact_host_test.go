package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/frontend"
)

// #14730: the trusted-preview host is served with its own policy, pinned directive by directive.
func TestArtifactHostIsServedWithItsOwnPolicy(t *testing.T) {
	rec := httptest.NewRecorder()
	serveArtifactHost(frontend.Static).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/artifact_host.html", nil))
	resp := rec.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	csp := resp.Header.Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "frame-src about:", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", "sandbox allow-scripts"} {
		assert.Contains(t, csp, want)
	}
	assert.NotContains(t, csp, "allow-same-origin")
	assert.Equal(t, 1, strings.Count(csp, "'self'"), "only frame-ancestors names 'self'")
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "off", resp.Header.Get("X-DNS-Prefetch-Control"))
	assert.Equal(t, "no-referrer", resp.Header.Get("Referrer-Policy"))
	assert.Contains(t, resp.Header.Get("Permissions-Policy"), "camera=()")
	assert.Contains(t, string(body), "coral-artifact-load")
	// the page's own <meta> says the same thing the header does (no directive the header lacks)
	assert.True(t, strings.Contains(string(body), "frame-src about:"))
}
