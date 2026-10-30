package verify

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #395: a staged release that is not newer than the installed version is dropped; what does not parse is left alone. The table is the one updatecheck.NotNewer (the server's) is tested
// with: the two functions must agree on every row.
func TestNotNewer(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "updatecheck", "testdata", "not_newer_cases.json"))
	require.NoError(t, err)
	var table struct {
		Cases []struct {
			Staged, Installed string
			NotNewer          bool
			Why               string
		}
	}
	require.NoError(t, json.Unmarshal(b, &table))
	require.NotEmpty(t, table.Cases)
	for _, tc := range table.Cases {
		assert.Equal(t, tc.NotNewer, NotNewer(tc.Staged, tc.Installed), tc.Staged+" vs "+tc.Installed+": "+tc.Why)
	}
}

// An installed -rc build is a version too: a release is above its own prerelease, and a staged version is always a release.
func TestACompareToInstalledOrdersAReleaseAboveItsOwnPrerelease(t *testing.T) {
	for _, tc := range []struct {
		staged, installed string
		want              int
	}{
		{"0.0.1", "0.0.1-rc1", 1}, // the release is offered to its own rc
		{"0.0.2", "0.0.1-rc1", 1},
		{"0.0.1", "0.0.2-rc1", -1}, // an rc of a later release is not downgraded to an earlier one
		{"2.0.5", "2.0.5", 0},
		{"2.0.6", "2.0.5", 1},
		{"2.0.1", "2.0.3", -1},
	} {
		got, err := CompareToInstalled(tc.staged, tc.installed)
		require.NoError(t, err, tc.staged+" vs "+tc.installed)
		assert.Equal(t, tc.want, got, tc.staged+" vs "+tc.installed)
	}
	for _, bad := range [][2]string{
		{"0.0.1-rc1", "0.0.1"}, // a staged version is never a prerelease
		{"v0.0.2", "0.0.1"},    // no leading v on either side
		{"0.0.2", "v0.0.1"},
		{"0.0.2", "dev"},
		{"0.0.2", ""},
		{"0.0.2", "0.0.1+build5"}, // no build metadata
		{"", "0.0.1"},
	} {
		_, err := CompareToInstalled(bad[0], bad[1])
		assert.Error(t, err, bad[0]+" vs "+bad[1])
	}
	assert.True(t, ParseInstalled("2.0.5-rc1"))
	assert.False(t, ParseInstalled("v2.0.5"))
	assert.False(t, ParseInstalled("dev"))
}
