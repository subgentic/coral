package testguard

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A stress runner that launches agents on the tmux backend starts a tmux server on its own socket (CORAL_DATA_DIR/tmux.sock). Killing the Coral server by pid does not stop it, and a runner that failed
// or was stopped left it, with its mock agents, running for hours (six from one day's agent-tasks runs). The helper every runner's EXIT trap calls stops that one server and nothing else.

// tmuxBinary is a tmux for these tests, or a skip.
func tmuxBinary(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("no tmux on Windows")
	}
	if p := os.Getenv("CORAL_TMUX_BIN"); p != "" {
		return p
	}
	if p, err := exec.LookPath("tmux"); err == nil {
		return p
	}
	if p := "/Applications/Coral.app/Contents/MacOS/tmux"; fileExists(p) {
		return p
	}
	t.Skip("no tmux here")
	return ""
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func tmuxAlive(tmux, sock string) bool {
	return exec.Command(tmux, "-S", sock, "list-sessions").Run() == nil
}

func startTmux(t *testing.T, tmux, sock string) {
	t.Helper()
	out, err := exec.Command(tmux, "-S", sock, "-f", "/dev/null", "new-session", "-d", "-s", "t", "sleep 300").CombinedOutput()
	require.NoError(t, err, string(out))
	t.Cleanup(func() { _ = exec.Command(tmux, "-S", sock, "kill-server").Run() })
	require.True(t, tmuxAlive(tmux, sock))
}

func TestKillTmuxServerStopsOnlyThisRunnersSocket(t *testing.T) {
	skipOnWindows(t)
	lib := bashLib(t, "backend.sh")
	tmux := tmuxBinary(t)
	root, err := os.MkdirTemp("", "ct") // a short path: a Unix socket's is limited
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	data := filepath.Join(root, "coral-data")
	require.NoError(t, os.MkdirAll(data, 0o755))
	mine, other := filepath.Join(data, "tmux.sock"), filepath.Join(root, "other.sock")
	startTmux(t, tmux, mine)
	startTmux(t, tmux, other)

	cmd := bashRun(`source "$1"; export CORAL_DATA_DIR="$2"; coral_test_kill_tmux_server; coral_test_kill_tmux_server; echo done`, lib, data)
	cmd.Env = append(cmd.Env, "CORAL_TMUX_BIN="+tmux)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Contains(t, string(out), "done", "it never fails the run, and a second call (nothing left) is harmless")
	assert.False(t, tmuxAlive(tmux, mine), "the runner's own tmux server is stopped")
	assert.True(t, tmuxAlive(tmux, other), "a tmux server on any other socket is left alone")
}

func TestKillTmuxServerWithNoDataFolderTouchesNothing(t *testing.T) {
	skipOnWindows(t)
	lib := bashLib(t, "backend.sh")
	tmux := tmuxBinary(t)
	root, err := os.MkdirTemp("", "ct")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	other := filepath.Join(root, "tmux.sock")
	startTmux(t, tmux, other)
	cmd := bashRun(`source "$1"; unset CORAL_DATA_DIR; coral_test_kill_tmux_server; echo done`, lib)
	cmd.Env = append(cmd.Env, "CORAL_TMUX_BIN="+tmux, "TMUX_TMPDIR="+root)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	assert.True(t, tmuxAlive(tmux, other), "with no data folder it stops nothing (never a default tmux server)")
}

// The census: every stress runner that starts a Coral server stops its tmux server on the way out. A runner added later without it fails here.
func TestEveryStressRunnerThatStartsAServerStopsItsTmuxServer(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "tests", "stress")
	files, err := filepath.Glob(filepath.Join(dir, "*.sh"))
	require.NoError(t, err)
	require.NotEmpty(t, files)
	checked := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		s := string(b)
		if !strings.Contains(s, "--no-browser") {
			continue // sourced by one that does, or no server of its own
		}
		checked++
		assert.True(t, strings.Contains(s, "coral_test_kill_tmux_server") || strings.Contains(s, "kill-server"),
			"%s starts a Coral server but does not stop its tmux server on exit (call coral_test_kill_tmux_server in its EXIT trap): the tmux server and its agents outlive the run", filepath.Base(f))
	}
	assert.GreaterOrEqual(t, checked, 5, "the census found the runners")
}
