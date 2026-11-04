package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Ignore and Undo of a question through Coral Hub (#13446, #13450): POST .../asks/{id}/close is the owner's alone and Interact; no other method, no other path under it, no other tier.
func TestTheAskCloseIsAnOwnerOnlyInteractRoute(t *testing.T) {
	const path = "/api/board/alpha/asks/42/close"
	assert.Equal(t, TierInteract, Classify(http.MethodPost, path, ""))
	pattern, mode := OwnerRoute(http.MethodPost, path)
	assert.Equal(t, "/api/board/{project}/asks/{messageID}/close", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the machine refuses anyone but the owner before the handler runs")
	assert.True(t, IsOwnerRoute(http.MethodPost, path))
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		assert.Equal(t, TierNever, Classify(m, path, ""), "only POST: "+m)
	}
	assert.Equal(t, TierNever, Classify(http.MethodPost, path+"/more", ""))
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/board/alpha/asks/close", ""))
}
