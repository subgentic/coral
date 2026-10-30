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
