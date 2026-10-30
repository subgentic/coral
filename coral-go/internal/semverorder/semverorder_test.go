package semverorder

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The table updatecheck.NotNewer and verify.NotNewer are tested with too: all three answer the same on every row.
func TestNotNewerSharedTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "updatecheck", "testdata", "not_newer_cases.json"))
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

func TestParseAndCompare(t *testing.T) {
	v, ok := Parse("v1.4.167-rc1")
	assert.True(t, ok)
	assert.Equal(t, [3]int{1, 4, 167}, v.Core)
	assert.Equal(t, []string{"rc1"}, v.Pre)
	for _, bad := range []string{"", "dev", "1.4", "1.4.167+b", "1.4.x", "../../etc"} {
		_, ok := Parse(bad)
		assert.False(t, ok, bad)
	}
	a, _ := Parse("2.0.3")
	b, _ := Parse("2.0.3-rc1")
	assert.Equal(t, 1, Compare(a, b), "a release is above its prerelease")
	assert.Equal(t, -1, Compare(b, a))
	assert.Equal(t, 0, Compare(a, a))
	assert.True(t, Newer("1.4.10", "1.4.9"), "numbers, not text")
	assert.False(t, Newer("dev", "1.4.9"))
}
