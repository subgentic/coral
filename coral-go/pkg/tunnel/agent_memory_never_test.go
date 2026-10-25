package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7454 (Security's rule): an agent's instruction and memory files are never reachable through Coral Hub in phase 1, at any tier or computer mode: the routes have no row in the table.
func TestAnAgentsMemoryFilesAreNeverThroughTheHub(t *testing.T) {
	for _, path := range []string{"/api/sessions/live/alpha/memory", "/api/sessions/live/alpha/memory/0123456789abcdef0123456789abcdef", "/api/sessions/live/claude-x/memory/"} {
		assert.Equal(t, TierNever, Classify(http.MethodGet, path, ""), path)
		for _, m := range []Mode{TierView, TierInteract, TierLaunch} {
			assert.False(t, AllowRequest(func() Mode { return m })(http.MethodGet, path, ""), "%s at %v", path, m)
		}
	}
}
