//go:build linux || darwin

package cloud

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9936: whether a credential is waiting at the well-known path is asked without reading or removing it (the start that leaves its Terms to the Hub asks before the bootstrap runs).
func TestWellKnownBootstrapOfferedTouchesNothing(t *testing.T) {
	_, dir, file := wellKnown(t)
	assert.True(t, wellKnownOffered(), "a credential waiting in a safe folder is an offer")
	assert.FileExists(t, file, "asking does not remove it")
	got, err := os.ReadFile(file)
	require.NoError(t, err)
	assert.Equal(t, goodCred+"\n", string(got), "or change it")

	require.NoError(t, os.Remove(file))
	assert.False(t, wellKnownOffered(), "an empty folder is no offer")

	require.NoError(t, os.WriteFile(file, []byte(goodCred), 0o600))
	require.NoError(t, os.Chmod(dir, 0o755))
	assert.True(t, wellKnownOffered(), "a folder that is not safe is an offer a bootstrap refuses with a reason, not silence")
	assert.FileExists(t, file, "and it was not removed")
}

func TestWellKnownBootstrapOfferedWithoutTheFolder(t *testing.T) {
	root, _, _ := wellKnown(t)
	require.NoError(t, os.RemoveAll(filepath.Join(root, "run")))
	assert.False(t, wellKnownOffered(), "no folder, no offer: a computer that never had one starts as before")
}
