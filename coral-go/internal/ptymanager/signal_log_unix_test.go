//go:build !windows

package ptymanager

import (
	"log/slog"
	"os/exec"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11157: three agents ended in the same second and nothing in the log said what ended them. A signal Coral sends is logged with its pid, signal and program.
func TestASignalCoralSendsIsLogged(t *testing.T) {
	var buf logBuf
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	cmd := exec.Command("sleep", "30")
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	defaultKillSeams.sendSignal(cmd.Process.Pid, syscall.SIGTERM)
	assert.Contains(t, buf.String(), "signalling a process")
	assert.Contains(t, buf.String(), "signal=terminated")
	assert.Contains(t, buf.String(), "command=sleep")
	_ = cmd.Wait()
}
