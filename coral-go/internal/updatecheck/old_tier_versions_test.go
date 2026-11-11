package updatecheck

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #15075: the beta and dropboxers build tiers are gone. A computer that still runs a release built as one (its version carries the tag's suffix) must be offered the next plain release
// and compare it as newer, so the people on those builds can move to prod and are never stuck on the old one.
func TestAnInstallOfARemovedTierIsOfferedTheNextPlainRelease(t *testing.T) {
	for _, current := range []string{"2.0.63-beta", "v2.0.63-beta", "2.0.63-forDropbox", "v2.0.64-forDropbox", "2.0.64-beta"} {
		assert.True(t, Newer("v2.0.65", current), "%s is offered v2.0.65", current)
		assert.False(t, Newer("v2.0.62", current), "%s is not offered an older release", current)
	}
	assert.True(t, Newer("v2.0.64", "2.0.64-beta"), "a prerelease of a version is older than the version")
	assert.True(t, Newer("v2.0.64", "v2.0.64-forDropbox"))
}
