//go:build darwin

package tmux

import (
	"context"
	"os"
	"strconv"
	"testing"

	"github.com/ebitengine/purego"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func responsiblePid(t *testing.T, pid int) int {
	t.Helper()
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	require.NoError(t, err)
	var get func(pid int32) int32
	purego.RegisterLibFunc(&get, lib, "responsibility_get_pid_responsible_for_pid")
	return int(get(int32(pid)))
}

// #12836: the tmux server Coral starts (and so every agent in it) must not be attributed to Coral.app: a GUI program of Coral.app that exited made macOS force-quit all of it. Run on a
// tmux server of the test's own socket and folder, never Coral's.
func TestTheTmuxServerCoralStartsIsNotAttributedToCoral(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	require.NoError(t, c.NewSession(ctx, "coral-resp-probe", t.TempDir()))
	out, err := c.run(ctx, "display-message", "-p", "-t", "coral-resp-probe", "#{pid}")
	require.NoError(t, err)
	server, err := strconv.Atoi(out)
	require.NoError(t, err)
	mine := responsiblePid(t, os.Getpid())
	got := responsiblePid(t, server)
	assert.NotEqual(t, mine, got, "the tmux server is attributed to the same responsible process as Coral, so macOS takes it down with Coral.app")
	assert.Equal(t, server, got, "the server is its own responsible process")
	pane, err := c.run(ctx, "display-message", "-p", "-t", "coral-resp-probe", "#{pane_pid}")
	require.NoError(t, err)
	pp, _ := strconv.Atoi(pane)
	assert.NotEqual(t, mine, responsiblePid(t, pp), "an agent in it is not attributed to Coral either")
}
