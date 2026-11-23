package devicekey

import (
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

var patternVar = regexp.MustCompile(`\{[a-z]+\}`)

// #20879: the connector and the hub keep the four Coral-Device-* headers on every route of KindRoutes (a write), and on no other route that is not an owner route. The tunnel holds its own copy of the table (it cannot
// import this package), so this test is what keeps the two equal.
func TestTheTunnelForwardsDeviceHeadersOnEveryRelayedRoute(t *testing.T) {
	for _, k := range RelayedKinds {
		for _, r := range KindRoutes[k] {
			path := patternVar.ReplaceAllString(r.Pattern, "x1")
			assert.True(t, tunnel.ForwardsDeviceHeaders(r.Method, path), "%s %s (%s)", r.Method, r.Pattern, k)
			assert.True(t, tunnel.IsRelayedRoute(r.Method, path), "%s %s (%s)", r.Method, r.Pattern, k)
			assert.False(t, tunnel.ForwardsDeviceHeaders("GET", path), "a read never carries them: %s", r.Pattern)
		}
	}
	// What is not in the table is not forwarded (this one is a write that is not an owner route either).
	for _, r := range [][2]string{{"POST", "/api/sessions/live/x1/keys"}, {"POST", "/api/board/x1/messages/x2/edit"}, {"PUT", "/api/sessions/live/x1/send"}, {"POST", "/api/sessions/live/x1/send/x"}} {
		assert.False(t, tunnel.IsRelayedRoute(r[0], r[1]), "%s %s", r[0], r[1])
	}
	assert.Len(t, tunnel.RelayedRoutes(), func() int {
		n := 0
		for _, k := range RelayedKinds {
			n += len(KindRoutes[k])
		}
		return n
	}(), "the tunnel's table has exactly the routes of KindRoutes")
}
