package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The device-signed routes (#19669 slice 7): reachable from the Hub at View in any mode, and neither the owner's nor the service's: the signature is the only authority, so no marker or stamp rides on them, and they grant nothing elsewhere.
func TestTheDeviceSignedRoutesAreViewPostOnlyAndNeitherOwnerNorService(t *testing.T) {
	for _, p := range []string{"/api/device-keys/message", "/api/device-keys/certificate"} {
		assert.Equal(t, TierView, Classify(http.MethodPost, p, ""), p)
		assert.False(t, IsOwnerRoute(http.MethodPost, p), "no owner marker is stamped on %s", p)
		assert.False(t, IsServiceRoute(http.MethodPost, p), p)
		assert.False(t, ForwardsDeviceHeaders(http.MethodPost, p), "the step-1 evidence headers do not ride on %s", p)
		for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			assert.Equal(t, TierNever, Classify(m, p, ""), m+" "+p)
		}
		assert.Equal(t, TierNever, Classify(http.MethodPost, p+"/x", ""))
	}
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/device-keys", ""), "a sibling is not swallowed")
}
