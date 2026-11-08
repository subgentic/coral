package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14353 and #14414: the first-launch notice may be READ through Coral Hub by this computer's owner, at View tier, for the Computers page (the text and the seen flag). Acknowledging it and clearing the
// acknowledgement are the person at this computer's own dashboard: never through the tunnel. Security's ruling: OwnerRefuse (the machine refuses anyone but the owner), no query keys.
func TestTheLaunchNoticeIsReadableThroughTheHubByTheOwnerOnly(t *testing.T) {
	const path = "/api/launch-disclosure"
	assert.Equal(t, TierView, Classify(http.MethodGet, path, ""))
	pattern, mode := OwnerRoute(http.MethodGet, path)
	assert.Equal(t, path, pattern)
	assert.Equal(t, OwnerRefuse, mode, "the owner's alone: a grantee or a viewer is refused by the machine")
	assert.True(t, mode.Refuses())
	for tier, want := range map[Mode]bool{TierView: true, TierInteract: true, TierLaunch: true} {
		tier := tier
		assert.Equal(t, want, AllowRequest(func() Mode { return tier })(http.MethodGet, path, ""), "a computer at mode %v", tier)
	}
	assert.Equal(t, TierNever, Classify(http.MethodGet, path+"?x=1", "x=1"), "no query keys")
	// the acknowledgement and its clearing, and every other method, never come through the tunnel
	for _, m := range []string{http.MethodPost, http.MethodDelete, http.MethodPut, http.MethodPatch} {
		assert.Equal(t, TierNever, Classify(m, path, ""), "no write of the notice: "+m)
		assert.Equal(t, TierNever, Classify(m, path+"/ack", ""), "the acknowledgement stays local: "+m)
	}
	assert.Equal(t, TierNever, Classify(http.MethodGet, path+"/ack", ""))
}
