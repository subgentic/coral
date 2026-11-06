package testtemp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13745 (QA Reviewer 2's SHOULD): OutsideTemp moves the temp folder in the package where nothing else redirects it, for that test only. The home it gives is a real, empty folder that is not
// under the moved temp folder (what agent.InTempFolder looks at) and not inside the source tree; the variables are back when the test ends.
func TestOutsideTempMovesTheTempFolderForThatTestOnly(t *testing.T) {
	before := os.TempDir()
	var home, during string
	t.Run("inside", func(t *testing.T) {
		home = OutsideTemp(t)
		during = os.TempDir()
		assert.NotEqual(t, before, during, "the temp folder moved")
		for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
			assert.Equal(t, during, os.Getenv(k), k)
		}
		rel, err := filepath.Rel(during, home)
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(rel, ".."), "the home is not under the moved temp folder (%s)", rel)
		entries, err := os.ReadDir(home)
		require.NoError(t, err)
		assert.Empty(t, entries, "a new, empty folder")
		here, err := filepath.Abs(".")
		require.NoError(t, err)
		rel, err = filepath.Rel(here, home)
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(rel, ".."), "and not inside the package's source folder (%s)", rel)
	})
	assert.Equal(t, before, os.TempDir(), "t.Setenv put the temp folder back")
	_, err := os.Stat(home)
	assert.True(t, os.IsNotExist(err), "the folder went with the test")
}
