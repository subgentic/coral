//go:build windows

package ptymanager

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #408, the exited-agent gate on Windows (real processes): a root shell whose only child is Coral's launcher cmd for the resolved CLI, a .cmd that blocks in a builtin and starts nothing,
// is the agent running, so the terminal is NOT idle (ShellIdle/OtherShell go through shellTree). Without the launcher check the tree read as "only shells": the bare prompt, and the
// notice was withheld before the recorded-process check ever ran. Another batch file under the same root is not the agent.

// startUnder starts an interactive cmd (the root) and types `cmd /d /c "<script>"` into it: a verified cmd child of the root running the script.
func startUnder(t *testing.T, script string) *exec.Cmd {
	t.Helper()
	root := exec.Command("cmd.exe", "/d", "/q")
	in, err := root.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, root.Start())
	t.Cleanup(func() { in.Close(); _ = root.Process.Kill(); _ = root.Wait() })
	_, err = in.Write([]byte("cmd.exe /d /c \"" + script + "\"\r\n"))
	require.NoError(t, err)
	return root
}

func writeBlocking(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(p, []byte("@set /p x=\r\n"), 0o755)) // blocks reading its input, starts no program
	return p
}

func TestTheLauncherCmdThatIsTheCLIIsBusyThroughTheExitedGate(t *testing.T) {
	dir := t.TempDir()
	cli := writeBlocking(t, dir, "oldstub.cmd")
	a := &winAgent{}
	a.noteLaunch("", cli)
	check := a.launcherCheck()
	require.NotNil(t, check)

	root := startUnder(t, cli)
	busy := false
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline) && !busy; time.Sleep(200 * time.Millisecond) {
		var err error
		busy, _, err = shellTree(root.Process.Pid, check)
		require.NoError(t, err)
	}
	assert.True(t, busy, "the launcher cmd that is the resolved CLI is the agent running")

	plain, other, err := shellTree(root.Process.Pid)
	require.NoError(t, err)
	assert.False(t, plain, "without the launcher check the tree is only shells (the bug)")
	assert.Empty(t, other)

	// no resolved CLI known: nothing is recognised
	noCLI := &winAgent{}
	assert.Nil(t, noCLI.launcherCheck())
}

func TestAnotherBatchFileUnderTheRootIsNotTheAgent(t *testing.T) {
	dir := t.TempDir()
	cli := writeBlocking(t, dir, "oldstub.cmd")
	other := writeBlocking(t, dir, "other.cmd")
	a := &winAgent{}
	a.noteLaunch("", cli)

	root := startUnder(t, other)
	time.Sleep(2 * time.Second) // it is running by now
	busy, _, err := shellTree(root.Process.Pid, a.launcherCheck())
	require.NoError(t, err)
	assert.False(t, busy, "a cmd running some other file is a shell with nothing under it, not the agent")
}
