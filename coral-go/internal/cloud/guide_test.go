package cloud

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #11457: the server repeats the connector's decision for a guide. A request that claims to be one in any way is judged by guideAllowed; a forged, repeated or incomplete stamp is a refusal.

func guideStampHeaders() map[string]string {
	return map[string]string{tunnel.ViaHeader: ViaSecret(), tunnel.HubRoleHeader: "guide", tunnel.HubGuideBoardHeader: "dev team", tunnel.HubGuideLabelHeader: "hub-user-1234abcd", tunnel.HubGuideSinceHeader: "2026-10-31T07:00:00Z", tunnel.HubUserHeader: "hub-user-1234abcd"}
}

func guideReq(method, target string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestGuideCallerNeedsTheConnectorsSecretAndACompleteSingleStamp(t *testing.T) {
	g, ok := GuideCaller(guideReq("GET", "/api/board/x/messages", guideStampHeaders()))
	require.True(t, ok)
	assert.Equal(t, tunnel.HubGuide{Board: "dev team", Label: "hub-user-1234abcd", Since: "2026-10-31T07:00:00Z"}, g)
	for name, mut := range map[string]func(h map[string]string){
		"no secret":        func(h map[string]string) { delete(h, tunnel.ViaHeader) },
		"a forged secret":  func(h map[string]string) { h[tunnel.ViaHeader] = "1" },
		"another role":     func(h map[string]string) { h[tunnel.HubRoleHeader] = "owner" },
		"no board":         func(h map[string]string) { delete(h, tunnel.HubGuideBoardHeader) },
		"no label":         func(h map[string]string) { delete(h, tunnel.HubGuideLabelHeader) },
		"no start":         func(h map[string]string) { delete(h, tunnel.HubGuideSinceHeader) },
		"a bad label":      func(h map[string]string) { h[tunnel.HubGuideLabelHeader] = "someone" },
		"a bad start":      func(h map[string]string) { h[tunnel.HubGuideSinceHeader] = "yesterday" },
		"a board with a /": func(h map[string]string) { h[tunnel.HubGuideBoardHeader] = "a/b" },
		"another hub user": func(h map[string]string) { h[tunnel.HubUserHeader] = "hub-user-00000000" },
	} {
		h := guideStampHeaders()
		mut(h)
		_, ok := GuideCaller(guideReq("GET", "/api/board/x/messages", h))
		assert.False(t, ok, name)
	}
	r := guideReq("GET", "/api/board/x/messages", guideStampHeaders())
	r.Header.Add(tunnel.HubRoleHeader, "guide")
	_, ok = GuideCaller(r)
	assert.False(t, ok, "a repeated role header is no stamp")
	r = guideReq("GET", "/api/board/x/messages", guideStampHeaders())
	r.Header.Add(tunnel.HubGuideBoardHeader, "other")
	_, ok = GuideCaller(r)
	assert.False(t, ok, "a repeated board header is no stamp")
}

func TestGuardRefusesAnyClaimToBeAGuideThatIsNotWholeAuthenticAndServed(t *testing.T) {
	h := guardServer(t)
	board := "/api/board/dev%20team"
	// the routes served for a guide pass with a perfect stamp, on the grant's board
	for _, target := range []string{board + "/messages", board + "/messages?limit=20", board + "/goals?state=proposed&limit=5", board + "/goals/12"} {
		assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, target, guideStampHeaders()).Code, target)
	}
	// the writes need the route table's tier as for anyone: refused at View, through at Launch
	assert.Equal(t, http.StatusForbidden, serveGuard(h, http.MethodPost, board+"/messages", guideStampHeaders()).Code, "the viewer's tier still applies to a guide")
	hl := Guard(func() tunnel.Mode { return tunnel.TierLaunch })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	assert.Equal(t, http.StatusNoContent, serveGuard(hl, http.MethodPost, board+"/messages", guideStampHeaders()).Code)
	assert.Equal(t, http.StatusNoContent, serveGuard(hl, http.MethodPost, board+"/goals", guideStampHeaders()).Code)
	// a route of the table that is not served yet, and a route outside it, are refused
	for _, target := range []string{"/api/artifacts/" + strings.Repeat("a", 64), "/api/artifacts/" + strings.Repeat("a", 64) + "/comments", board + "/artifacts", board + "/settings", "/api/health"} {
		rec := serveGuard(h, http.MethodGet, target, guideStampHeaders())
		assert.Equal(t, http.StatusForbidden, rec.Code, target)
		assert.Contains(t, rec.Body.String(), GuardRefusedCode)
	}
	// a query parameter the route does not allow is refused (the closed filter)
	for _, target := range []string{board + "/messages?all=true", board + "/messages?subscriber_id=Operator", board + "/messages?limit=5&since=0", board + "/goals?subscriber_id=x", board + "/goals/12?x=1"} {
		assert.Equal(t, http.StatusForbidden, serveGuard(h, http.MethodGet, target, guideStampHeaders()).Code, target)
	}
	// another board's path is not found, as an unknown route is, whatever the route
	for _, target := range []string{"/api/board/other/messages", "/api/board/other/goals", "/api/board/dev%20teams/messages", "/api/board/Dev%20Team/messages"} {
		rec := serveGuard(h, http.MethodGet, target, guideStampHeaders())
		assert.Equal(t, http.StatusNotFound, rec.Code, target)
		assert.NotContains(t, rec.Body.String(), GuardRefusedCode, target)
	}
	// a forged copy from a browser or an agent (no secret), the guide headers alone, and a lone role header
	for name, hdr := range map[string]map[string]string{
		"role only":               {tunnel.HubRoleHeader: "guide"},
		"board only":              {tunnel.HubGuideBoardHeader: "x"},
		"label only":              {tunnel.HubGuideLabelHeader: "hub-user-1234abcd"},
		"start only":              {tunnel.HubGuideSinceHeader: "2026-10-31T07:00:00Z"},
		"a full stamp, no secret": {tunnel.HubRoleHeader: "guide", tunnel.HubGuideBoardHeader: "dev team", tunnel.HubGuideLabelHeader: "hub-user-1234abcd", tunnel.HubGuideSinceHeader: "2026-10-31T07:00:00Z"},
	} {
		assert.Equal(t, http.StatusForbidden, serveGuard(h, http.MethodGet, board+"/messages", hdr).Code, name)
	}
	// a request that says nothing of a guide is judged as before
	assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, "/api/health", nil).Code)
	assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, "/api/board/x/messages", map[string]string{tunnel.ViaHeader: ViaSecret()}).Code, "an ordinary viewer is not a guide")
}

func TestGuideAllowedWithAServedRoute(t *testing.T) {
	served := []string{"GET /api/board/{project}/messages"}
	assert.True(t, guideAllowedWith(guideReq("GET", "/api/board/x/messages", guideStampHeaders()), served))
	assert.True(t, guideAllowedWith(guideReq("HEAD", "/api/board/x/messages", guideStampHeaders()), served))
	assert.False(t, guideAllowedWith(guideReq("POST", "/api/board/x/messages", guideStampHeaders()), served), "a route in the table and not served")
	assert.False(t, guideAllowedWith(guideReq("GET", "/api/board/x/goals", guideStampHeaders()), served))
	assert.False(t, guideAllowedWith(guideReq("GET", "/api/board/x/settings", guideStampHeaders()), []string{"GET /api/board/{project}/settings"}), "a served entry that is not in the table never opens a route")
}

func TestEveryServedGuideRouteIsInTheGuideTable(t *testing.T) {
	in := map[string]bool{}
	for _, g := range tunnel.GuideRoutes() {
		in[g.Method+" "+g.Pattern] = true
	}
	for _, s := range guideServed {
		assert.True(t, in[s], "%s is served for a guide but is not in the guide table", s)
	}
}
