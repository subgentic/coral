//go:build !windows

package tmux

import (
	"context"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A real tmux server on an isolated socket (never Coral's own): up with its pid, then killed hard, which is what a server dying looks like (#12592).
func TestServerStateSeesTheServerUpAndThenGone(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	before := c.ServerState(ctx)
	assert.True(t, before.Known && !before.Up, "no server yet is a known 'not up': %+v", before)

	createTestSession(t, c, "claude-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", t.TempDir())
	up := c.ServerState(ctx)
	require.True(t, up.Known && up.Up, "%+v", up)
	assert.Greater(t, up.PID, 1)
	assert.Equal(t, 1, up.Sessions)

	require.NoError(t, syscall.Kill(up.PID, syscall.SIGKILL), "the isolated server, by the pid it reported")
	require.Eventually(t, func() bool {
		s := c.ServerState(ctx)
		return s.Known && !s.Up
	}, 5*time.Second, 50*time.Millisecond, "a killed server is a known 'not up', not an unknown answer")
}

func TestServerStateOfAClientWithNoSocketIsUnknown(t *testing.T) {
	c := &Client{TmuxBin: "tmux", sessionSockets: map[string]string{}}
	assert.Equal(t, ServerState{}, c.ServerState(context.Background()), "no socket of Coral's own: nothing to watch, nothing to report")
}
