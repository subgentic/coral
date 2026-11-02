package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12213: Hermes's first-use setup (it prepares its dependencies) failed and its CLI exited, from the tester's capture of v0.22.5 (a fetch from pypi.org timed out while three homes prepared at once).
func TestHermesSetupFailedIn(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "hermes_setup_failed.txt"))
	require.NoError(t, err)
	assert.True(t, HermesSetupFailedIn(string(b)), "the captured screen")
	assert.True(t, HermesSetupFailedIn("hermes: NO DEPENDENCY ENVIRONMENT\n  IS COMMITTED FOR THIS INSTALL; run `hermes pm repair`"), "case and a wrapped line")
	assert.False(t, HermesSetupFailedIn("hermes: preparing dependencies for this data root (the checkout's updates belong to /home/tester/hermes-home)..."), "setup that is only running")
	assert.False(t, HermesSetupFailedIn("run `hermes pm repair`"), "a hint alone")
	assert.False(t, HermesSetupFailedIn(""))
}
