package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Chief through Coral Hub (#11470): the recorded Chief is an API read, the owner's alone. The connector's path allowlist is untouched: no page route is carried, only /api/ and /ws/.
func TestChiefStateIsAnOwnerOnlyViewRouteAndNoPageIsCarried(t *testing.T) {
	assert.Equal(t, TierView, Classify(http.MethodGet, "/api/chief", ""))
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		assert.Equal(t, TierNever, Classify(m, "/api/chief", ""), "only GET: "+m)
	}
	assert.Equal(t, TierNever, Classify(http.MethodGet, "/api/chief/other", ""))
	pattern, mode := OwnerRoute(http.MethodGet, "/api/chief")
	assert.Equal(t, "/api/chief", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the owner's alone: the machine refuses anyone else before it reads a setting")
	assert.True(t, IsOwnerRoute(http.MethodGet, "/api/chief"))
	// the page itself is not a route of the tunnel, and the connector's allowlist does not name it
	assert.Equal(t, TierNever, Classify(http.MethodGet, "/chief", ""))
	assert.Error(t, ValidatePath("/chief"))
	assert.Error(t, ValidatePath("/chief/"))
}
