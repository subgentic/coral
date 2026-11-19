package startup

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

// Slice 4: Coral makes its one computer key at startup (identity only, 0600 in the data folder). A key file it will not use leaves the pairing off, with a log line, and never stops Coral or makes a new identity.
func TestLoadComputerKeyMakesOnceAndRefusesABadFile(t *testing.T) {
	dir := t.TempDir()
	a := loadComputerKey(dir)
	require.NotNil(t, a)
	b := loadComputerKey(dir)
	require.NotNil(t, b)
	assert.Equal(t, a.Pub(), b.Pub())
	if runtime.GOOS == "windows" {
		return
	}
	require.NoError(t, os.Chmod(filepath.Join(dir, devicekey.ComputerKeyFile), 0o644))
	assert.Nil(t, loadComputerKey(dir), "a readable key file is not used, and not replaced")
}
