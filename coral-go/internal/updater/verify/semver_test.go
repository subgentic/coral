package verify

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #395: a staged release that is not newer than the installed version is dropped; what does not parse is left alone.
func TestNotNewer(t *testing.T) {
	for _, tc := range []struct {
		staged, installed string
		want              bool
	}{
		{"2.0.1", "2.0.3", true},      // lower
		{"2.0.3", "2.0.3", true},      // equal
		{"2.0.4", "2.0.3", false},     // higher
		{"2.0.3", "2.0.3-rc1", false}, // the release is newer than its prerelease
		{"2.0.3", "2.0.4-rc1", true},  // lower than a later prerelease
		{"2.0.4", "2.0.4-rc1", false},
		{"2.0.3", "v2.0.3", true},       // a "v" on the installed one
		{"2.0.3", "2.0.3+build5", true}, // build metadata is not a prerelease
		{"2.0.1", "dev", false},         // nothing is dropped on a guess
		{"2.0.1", "", false},
		{"2.0.3-rc1", "2.0.3", false}, // a staged release is a plain X.Y.Z: anything else is left alone
	} {
		assert.Equal(t, tc.want, NotNewer(tc.staged, tc.installed), tc.staged+" vs "+tc.installed)
	}
}
