package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Keep Full access when this agent restarts (#14061) widens what a Codex agent may do on its next start, so through Coral Hub it is the owner's alone AND Launch: a computer set to Interact (or View)
// refuses it before the handler runs, even for the owner (Security's MUST).
func TestKeepFullAccessIsAnOwnerOnlyLaunchRoute(t *testing.T) {
	const path = "/api/sessions/live/codex-dev/keep-full-access"
	assert.Equal(t, TierLaunch, Classify(http.MethodPost, path, ""))
	pattern, mode := OwnerRoute(http.MethodPost, path)
	assert.Equal(t, "/api/sessions/live/{name}/keep-full-access", pattern)
	assert.Equal(t, OwnerRefuse, mode)
	for tier, want := range map[Mode]bool{TierView: false, TierInteract: false, TierLaunch: true} {
		tier := tier
		assert.Equal(t, want, AllowRequest(func() Mode { return tier })(http.MethodPost, path, ""), "a computer at mode %v", tier)
	}
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		assert.Equal(t, TierNever, Classify(m, path, ""), "only POST: "+m)
	}
}
