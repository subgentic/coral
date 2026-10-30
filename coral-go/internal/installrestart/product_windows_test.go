//go:build windows

package installrestart

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// inLocalAppData puts the user's Local AppData folder at a new test folder for the test.
func inLocalAppData(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := localAppData
	localAppData = func() (string, error) { return dir, nil }
	t.Cleanup(func() { localAppData = old })
	return dir
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	require.NoError(t, err)
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

// The installer's helper runs from a temporary copy, so it is told its product: the rehearsal's marks and log go to "Coral Rehearsal" and the live
// "Coral" folder is never named (the isolation the rehearsal needs, and Security's rule that a mark never falls back to Coral).
func TestAMarkForAProductIsInThatProductsFolderOnly(t *testing.T) {
	local := inLocalAppData(t)
	now := time.Now()
	require.NoError(t, MarkFor("Coral Rehearsal", now))
	assert.Equal(t, []string{"Coral Rehearsal"}, names(t, local), "only the rehearsal's folder exists: the live Coral's is not made")
	assert.Equal(t, []string{fileName}, names(t, filepath.Join(local, "Coral Rehearsal")))
	assert.True(t, TakeFor("Coral Rehearsal", now))
	assert.False(t, TakeFor("Coral Rehearsal", now), "taken once")

	require.NoError(t, MarkFor("Coral Rehearsal", now))
	f, err := CreateLogFor("Coral Rehearsal", "coral-msi-helper")
	require.NoError(t, err)
	f.Close()
	require.NoError(t, DiscardFor("Coral Rehearsal"))
	assert.Len(t, names(t, filepath.Join(local, "Coral Rehearsal")), 1, "the log stays, the mark is gone")
	assert.NotContains(t, names(t, local), "Coral")

	require.NoError(t, MarkFor("Coral", now))
	assert.Contains(t, names(t, local), "Coral", "the live product's name goes to the live product's folder")
}

func TestABadProductNameTouchesNothing(t *testing.T) {
	local := inLocalAppData(t)
	for _, bad := range []string{"", "coral", "Cor", "Coral  X", "Coral Rehearsal Beta", "Coral/x", `Coral\x`, "..", `..\Coral`, "Coral Rehearsal\x00", " Coral", "Coral\n"} {
		assert.ErrorIs(t, MarkFor(bad, time.Now()), ErrBadProduct, "%q", bad)
		assert.ErrorIs(t, DiscardFor(bad), ErrBadProduct, "%q", bad)
		assert.False(t, TakeFor(bad, time.Now()), "%q", bad)
		f, err := CreateLogFor(bad, "x")
		assert.ErrorIs(t, err, ErrBadProduct, "%q", bad)
		if f != nil {
			f.Close()
		}
		assert.False(t, ValidProduct(bad), "%q", bad)
	}
	assert.Empty(t, names(t, local), "nothing was made anywhere")
}
