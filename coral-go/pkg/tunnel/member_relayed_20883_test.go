package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20883: a Hub's owner may give and end a member's access, signed by the owner's own device. The four routes are shut (never, as before) until MemberRelayedOpen is true, which changes only in a commit
// Security reads; open, they are the owner's, Launch tier, and nobody else's. The lists (GET) stay this computer's.
var memberRelayedRoutes = []struct{ method, path string }{
	{http.MethodPost, "/api/member-grants"},
	{http.MethodDelete, "/api/member-grants/abc"},
	{http.MethodPost, "/api/board/team1/member-grants"},
	{http.MethodDelete, "/api/board/team1/member-grants/abc"},
}

func TestMemberGrantRoutesAreShutUntilTheRelayedGateOpens(t *testing.T) {
	assert.False(t, MemberRelayedOpen, "ships shut")
	for _, r := range memberRelayedRoutes {
		assert.Equal(t, TierNever, Classify(r.method, r.path, ""), "%s %s shut", r.method, r.path)
	}
	OpenMemberRelayedForTest(t)
	for _, r := range memberRelayedRoutes {
		assert.Equal(t, TierLaunch, Classify(r.method, r.path, ""), "%s %s open", r.method, r.path)
		_, mode := OwnerRoute(r.method, r.path)
		assert.Equal(t, OwnerHubOnly, mode, "%s %s is the owner's, through a Hub only", r.method, r.path)
		assert.True(t, IsRelayedRoute(r.method, r.path), "%s %s takes the relayed signature headers", r.method, r.path)
		assert.True(t, ForwardsDeviceHeaders(r.method, r.path), "%s %s", r.method, r.path)
	}
	for _, p := range []string{"/api/member-grants", "/api/board/team1/member-grants"} {
		assert.Equal(t, TierNever, Classify(http.MethodGet, p, ""), "the list is read at this computer: GET %s", p)
		assert.Equal(t, TierNever, Classify(http.MethodPut, p, ""), "PUT %s", p)
	}
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/member-grants", "x=1"), "no query")
}

func TestMemberRelayedGateIsShutAgainAfterATest(t *testing.T) {
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/member-grants", ""))
}
