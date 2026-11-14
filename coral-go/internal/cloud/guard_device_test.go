package cloud

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #16654: the device key's signature headers belong to the connector. A request that did not come through it (a browser, an agent, a local program, a forged stamp) has them removed before any handler.
func TestGuardRemovesDeviceHeadersFromARequestThatDidNotComeThroughTheConnector(t *testing.T) {
	var seen http.Header
	h := Guard(func() tunnel.Mode { return tunnel.TierLaunch })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = r.Header.Clone() }))
	for name, via := range map[string]string{"no stamp": "", "a forged stamp": "1", "the connector's stamp": ViaSecret()} {
		r := httptest.NewRequest(http.MethodPost, "/api/board/team/artifacts/"+strings.Repeat("a", 64)+"/review", nil)
		r.Header["coral-device-key"] = []string{"a2V5"}
		r.Header.Set(tunnel.DeviceSigHeader, "c2ln")
		if via != "" {
			r.Header.Set(tunnel.ViaHeader, via)
		}
		seen = nil
		h.ServeHTTP(httptest.NewRecorder(), r)
		if seen == nil {
			t.Fatalf("%s: the request did not reach the handler", name)
		}
		if via == ViaSecret() {
			assert.Equal(t, "c2ln", seen.Get(tunnel.DeviceSigHeader), name+": the connector's own request keeps them")
			continue
		}
		assert.Empty(t, seen.Get(tunnel.DeviceSigHeader), name)
		assert.NotContains(t, seen, "coral-device-key", name+": in any spelling")
	}
}
