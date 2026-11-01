//go:build windows

package ptymanager

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
)

// A real terminal whose shell is cmd, in a folder that holds You.bat: the gate types nothing into it, so nothing in the folder runs.
func TestATerminalWhoseShellIsCmdGetsNoTypedText(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "You.bat"), []byte("@echo ran> \""+marker+"\"\r\n"), 0o644))
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-0425-cmdshell"
	require.NoError(t, b.Spawn(name, "claude", dir, "0425", "cmd.exe /d /q", 120, 40))
	require.Eventually(t, func() bool { refused, _, found := b.AgentTextRefused(name); return found && refused }, 20*time.Second, 200*time.Millisecond)
	_, why, _ := b.AgentTextRefused(name)
	assert.Equal(t, reasonCmdShell, why)

	// The gate is otherwise willing: this terminal has no screen to read (nothing else holds the text), only the answer of the real backend on whether text may go.
	term := NewPTYSessionTerminal(b)
	text := "You have a message on the board"
	got, err := DeliverAutomated(context.Background(), AutomatedInput{Term: backendText{b}, Name: name, SessionID: "0425", Text: text, What: "test notice",
		Send: func(ctx context.Context) error {
			return term.SendInput(ctx, terminalinput.Coral, name, text, "claude", "")
		}})
	require.NoError(t, err)
	assert.Equal(t, Skipped, got, "nothing is typed")
	time.Sleep(time.Second)
	_, statErr := os.Stat(marker)
	assert.True(t, os.IsNotExist(statErr), "You.bat never ran")
}

// backendText asks the real backend whether text may go, and has no screen.
type backendText struct{ b *PTYBackend }

func (t backendText) AgentTextRefused(_ context.Context, name, _, _ string) (bool, string) {
	refused, why, _ := t.b.AgentTextRefused(name)
	return refused, why
}
