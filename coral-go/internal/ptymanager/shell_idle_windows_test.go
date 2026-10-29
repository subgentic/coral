//go:build windows

package ptymanager

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
)

// #378: on Windows the agent-exited guard (#3219) could never tell, as ConPTY names no shell pid for the ps check, so board notices
// were typed into the bare PowerShell an exited CLI left. A ConPTY session now says for itself: a shell with a program running in
// it is busy, the same shell back at its prompt is idle.
func TestWindowsShellIdleTellsABarePromptFromARunningProgram(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-378-idle"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0378", "powershell.exe -NoProfile", 120, 40))

	require.Eventually(t, func() bool {
		idle, shell, ok := b.ShellIdle(name)
		return ok && idle && shell == "powershell"
	}, 20*time.Second, 200*time.Millisecond, "a shell with nothing running in it is idle")

	// A program in the shell, as an agent CLI is: busy, so notices are typed to it.
	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("ping -n 6 127.0.0.1"+EnterKey)))
	require.Eventually(t, func() bool {
		idle, _, ok := b.ShellIdle(name)
		return ok && !idle
	}, 20*time.Second, 200*time.Millisecond, "a shell running a program is not idle")

	// The program ends (as an agent CLI exits): back at a bare prompt, idle again.
	require.Eventually(t, func() bool {
		idle, _, ok := b.ShellIdle(name)
		return ok && idle
	}, 20*time.Second, 200*time.Millisecond, "the shell is idle again once the program has exited")
}

// A program started directly as the terminal's root (an agent with no shell around it) is the agent itself: never idle.
func TestWindowsShellIdleADirectProgramIsNotIdle(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-378-direct"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0379", "ping.exe -n 30 127.0.0.1", 120, 40))
	time.Sleep(time.Second)
	idle, shell, ok := b.ShellIdle(name)
	if ok {
		assert.False(t, idle, "a direct program is not a bare shell (root %q)", shell)
	}
}
