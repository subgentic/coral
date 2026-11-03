package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Marking a file read through Coral Hub (#12742): PUT .../artifacts/{id}/tags is the owner's alone and Interact; no other method, no other path under it, and no other tier.
func TestTheArtifactTagsWriteIsAnOwnerOnlyInteractRoute(t *testing.T) {
	const path = "/api/board/alpha/artifacts/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/tags"
	assert.Equal(t, TierInteract, Classify(http.MethodPut, path, ""))
	pattern, mode := OwnerRoute(http.MethodPut, path)
	assert.Equal(t, "/api/board/{project}/artifacts/{id}/tags", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the machine refuses anyone but the owner before the handler runs")
	assert.True(t, IsOwnerRoute(http.MethodPut, path))
	for _, m := range []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete} {
		assert.Equal(t, TierNever, Classify(m, path, ""), "only PUT: "+m)
	}
	assert.Equal(t, TierNever, Classify(http.MethodPut, path+"/more", ""))
	assert.Equal(t, TierNever, Classify(http.MethodPut, "/api/board/alpha/artifacts/tags", ""))
}
