package hubproxy

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #19686: hub-211's owner-only cuts apply to a request that carries the tunnel's Via header, which only the Coral Hub connector sets.
// A self-hosted hub (coral --hub) must never relay that header from a browser or script, in any spelling: it would turn the cuts on
// (or fake the Cloud Hub) for a remote Coral that serves the person directly.
func TestSelfHostedHubNeverForwardsTheTunnelViaHeader(t *testing.T) {
	for _, spelling := range []string{tunnel.ViaHeader, "x-coral-via-tunnel", "X-CORAL-VIA-TUNNEL"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			h := http.Header{spelling: {"1"}, "Accept": {"application/json"}}
			allowlistHeaders(h, method, "/api/sessions/live")
			assert.NotContains(t, h, http.CanonicalHeaderKey(spelling), "%s %s", method, spelling)
			assert.Contains(t, h, "Accept")
		}
	}
}
