package server

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11457 (Security's tests 2 and 3): a guide is refused on every route the router serves until a slice of the guide work serves it. A table-driven walk of the whole router, so a route added later is refused
// for a guide by default; this list of served routes is the one place a guide's reach grows, and the guide table (pkg/tunnel) bounds it.
func TestAGuideIsRefusedOnEveryRouteThatIsNotServedForGuides(t *testing.T) {
	srv, _, _ := strictServer(t, false)
	h := srv.Router()
	param := regexp.MustCompile(`\{[^}]+\}`)
	stamp := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "guide", tunnel.HubGuideBoardHeader: "1", tunnel.HubGuideLabelHeader: "hub-user-1234abcd",
		tunnel.HubGuideSinceHeader: "2026-10-31T07:00:00Z", tunnel.HubUserHeader: "hub-user-1234abcd"}
	// "METHOD pattern" of the routes a guide reaches (cloud.guideServed): the five of slice B. They reach their handlers (guide_routes_test.go in routes checks what each does), so only the others are asked here.
	served := map[string]bool{
		"GET /api/board/{project}/messages": true, "POST /api/board/{project}/messages": true, "GET /api/board/{project}/goals": true, "GET /api/board/{project}/goals/{goalID}": true, "POST /api/board/{project}/goals": true,
	}
	n := 0
	require.NoError(t, chi.Walk(h, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodConnect || method == http.MethodTrace {
			return nil
		}
		path := param.ReplaceAllString(strings.TrimSuffix(route, "/*"), "1")
		req := httptest.NewRequest(method, path, strings.NewReader("{}"))
		for k, v := range stamp {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		n++
		if served[method+" "+route] {
			return nil
		}
		// refused by the table (403) or answered as an unknown route (404: the path names a board that is not the grant's)
		assert.Contains(t, []int{http.StatusForbidden, http.StatusNotFound}, rec.Code, "%s %s answers a guide (%d) and is not in the served list", method, route, rec.Code)
		if rec.Code == http.StatusForbidden {
			assert.Contains(t, rec.Body.String(), cloud.GuardRefusedCode, "%s %s", method, route)
		}
		return nil
	}))
	require.Greater(t, n, 200, "the walk met the router's routes")
}
