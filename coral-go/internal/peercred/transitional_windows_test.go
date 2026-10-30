//go:build windows

package peercred

import (
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/executil"
)

func openProcess(t *testing.T, pid uint32) windows.Handle {
	t.Helper()
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	require.NoError(t, err)
	t.Cleanup(func() { windows.CloseHandle(h) })
	return h
}

// #385 (b): the process behind a transitional row is running, and was created before the connection was accepted.
func TestCheckTransitionalOwnerNeedsARunningProcessCreatedBeforeTheAccept(t *testing.T) {
	self := openProcess(t, uint32(os.Getpid()))

	made, err := checkTransitionalOwner(self, time.Now().Add(time.Minute))
	require.NoError(t, err, "a running process created before the accept")
	assert.True(t, made.Before(time.Now()))

	// condition: created before the accept. A recycled pid is a NEW process: it was created after the accept of a connection that is older than it.
	_, err = checkTransitionalOwner(self, made.Add(-time.Hour))
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound, "created after the connection was accepted: not its owner")

	// condition: still running. A process that has exited (its pid is free to be recycled) is not an owner.
	cmd := exec.Command("cmd.exe", "/c", "exit 0")
	executil.HideWindow(cmd)
	require.NoError(t, cmd.Start())
	gone := openProcess(t, uint32(cmd.Process.Pid))
	require.NoError(t, cmd.Wait())
	_, err = checkTransitionalOwner(gone, time.Now().Add(time.Minute))
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrNotFound), "an exited process: %v", err)
}

// The switch: CORAL_PEERCRED_TRANSITIONAL=off falls back to failing closed.
func TestTransitionalRowsCanBeSwitchedOff(t *testing.T) {
	t.Setenv("CORAL_PEERCRED_TRANSITIONAL", "")
	assert.True(t, transitionalRowsOn(), "on by default")
	t.Setenv("CORAL_PEERCRED_TRANSITIONAL", "off")
	assert.False(t, transitionalRowsOn())
	t.Setenv("CORAL_PEERCRED_TRANSITIONAL", "on")
	assert.True(t, transitionalRowsOn())
}
