package hubproxy

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #16654: the hub sends the device key's signature headers only with a write to an owner route (the connector applies the same rule), in any spelling.
func TestAllowlistHeadersDeviceHeaders(t *testing.T) {
	review := "/api/board/team/artifacts/" + strings.Repeat("a", 64) + "/review"
	for _, c := range []struct {
		method, path string
		kept         bool
	}{
		{http.MethodPost, review, true},
		{http.MethodGet, review, false},
		{http.MethodPost, "/api/not-in-the-table", false},
	} {
		h := http.Header{"coral-device-key": {"a2V5"}, "Coral-Device-Sig": {"c2ln"}, "Coral-Device-Ts": {"1"}, "CORAL-DEVICE-NONCE": {"bg"}, "Accept": {"application/json"}, "Cookie": {"x=y"}}
		allowlistHeaders(h, c.method, c.path)
		n := 0
		for k := range h {
			if tunnel.IsDeviceHeader(k) {
				n++
			}
		}
		if c.kept {
			assert.Equal(t, 4, n, "%s %s", c.method, c.path)
		} else {
			assert.Zero(t, n, "%s %s", c.method, c.path)
		}
		assert.Contains(t, h, "Accept")
		assert.NotContains(t, h, "Cookie")
	}
}
