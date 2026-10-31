//go:build !windows

package opencode

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A server that ended on its own is not asked to end again: its pid may be another process's by now (a pid is reused), and Stop must not signal that one.
func TestStopAsksNothingOfAServerThatAlreadyEnded(t *testing.T) {
	other := exec.Command("sleep", "60")
	require.NoError(t, other.Start())
	go func() { _ = other.Wait() }()
	defer other.Process.Kill()
	impostor, err := os.FindProcess(other.Process.Pid)
	require.NoError(t, err)
	done := make(chan struct{})
	close(done) // the server's own wait has returned
	s := &Server{cmd: &exec.Cmd{Process: impostor}, dir: t.TempDir(), done: done}

	s.Stop()
	time.Sleep(300 * time.Millisecond)
	assert.True(t, testProcessAlive(other.Process.Pid), "Stop did not signal the process that holds the pid now")
}
