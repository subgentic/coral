package apply

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWritableNeedsTheInstallAndItsParent(t *testing.T) {
	parent := t.TempDir()
	install := filepath.Join(parent, "Coral.app")
	require.NoError(t, os.Mkdir(install, 0o755))
	assert.True(t, writable(install), "files can be made in the install and next to it")
	entries, err := os.ReadDir(parent)
	require.NoError(t, err)
	assert.Len(t, entries, 1, "the probe files are removed")
	left, err := os.ReadDir(install)
	require.NoError(t, err)
	assert.Empty(t, left)

	assert.False(t, writable(filepath.Join(parent, "missing")), "an install that does not exist cannot be written")

	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("a read-only folder does not stop this user")
	}
	require.NoError(t, os.Chmod(install, 0o555))
	t.Cleanup(func() { os.Chmod(install, 0o755) })
	assert.False(t, writable(install), "a read-only install is not writable")
	require.NoError(t, os.Chmod(install, 0o755))
	require.NoError(t, os.Chmod(parent, 0o555))
	t.Cleanup(func() { os.Chmod(parent, 0o755) })
	assert.False(t, writable(install), "a read-only parent is not writable")
}
