package tmux

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15011: on a computer with no tmux the status poll looked again every second, and each look started a login shell (the person's whole profile) per shell Coral tries, and said every miss again. A login shell's
// "no tmux" now stands for 30 seconds, and a miss is said once until tmux is found.

func noTmuxAnywhere(t *testing.T) (calls *int, clock *time.Time) {
	t.Helper()
	oldCommon, oldLogin, oldNow := commonTmuxPaths, loginShellTmux, loginNow
	n := 0
	now := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	commonTmuxPaths = nil
	loginShellTmux = func() string { n++; return "" }
	loginNow = func() time.Time { return now }
	t.Cleanup(func() { commonTmuxPaths, loginShellTmux, loginNow = oldCommon, oldLogin, oldNow })
	t.Setenv("PATH", filepath.Join(t.TempDir(), "empty"))
	t.Setenv("CORAL_TMUX_BIN", "")
	return &n, &now
}

func TestALoginShellsNoTmuxAnswerStandsForThirtySeconds(t *testing.T) {
	captureLog(t)
	calls, clock := noTmuxAnywhere(t)
	for i := 0; i < 20; i++ { // the poll, every second for twenty
		_, ok := IsAvailable()
		require.False(t, ok)
		*clock = clock.Add(time.Second)
	}
	assert.Equal(t, 1, *calls, "twenty looks in twenty seconds start the login shells once")
	*clock = clock.Add(loginShellMissFor)
	_, ok := IsAvailable()
	require.False(t, ok)
	assert.Equal(t, 2, *calls, "after the thirty seconds it asks again (a tmux the profile adds is found)")
}

func TestATmuxInstalledMeanwhileIsFoundAtOnceInThePathOrACommonPlace(t *testing.T) {
	captureLog(t)
	calls, _ := noTmuxAnywhere(t)
	_, ok := IsAvailable()
	require.False(t, ok)
	require.Equal(t, 1, *calls)
	dir := t.TempDir()
	fake := filepath.Join(dir, "tmux")
	writeExecutable(t, fake)
	commonTmuxPaths = []string{fake} // installed in a common place: no login shell needed, the cached miss does not hide it
	p, ok := IsAvailable()
	require.True(t, ok)
	assert.Equal(t, fake, p)
	assert.Equal(t, 1, *calls)
}

func TestAMissIsSaidOnceUntilTmuxIsFound(t *testing.T) {
	buf := captureLog(t)
	miss := []string{"login shell tmux lookup failed: shell=%q err=exit status 1", "discovery failed: shell=%q", "cached tmux binary not found on PATH: bin=%q"}
	for i := 0; i < 6; i++ { // the lines take turns, as the poll's do
		for _, m := range miss {
			logDiscovery(m, "bash")
		}
	}
	assert.Len(t, tmuxLines(buf), 3, "each miss once, however often the poll looks")
	logDiscovery("discovery found tmux in common path: %s", "/usr/bin/tmux") // tmux appeared
	for _, m := range miss {
		logDiscovery(m, "bash")
	}
	assert.Len(t, tmuxLines(buf), 7, "found, then gone again: the misses are news again")
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755))
}

// tmuxLines are the lines of the log that say something about tmux discovery, whatever they begin with.
func tmuxLines(buf *bytes.Buffer) []string {
	var out []string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, "[tmux] ") {
			out = append(out, l)
		}
	}
	return out
}
