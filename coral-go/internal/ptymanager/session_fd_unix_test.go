//go:build !windows

package ptymanager

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openFDs(t *testing.T) int {
	t.Helper()
	for _, dir := range []string{"/dev/fd", "/proc/self/fd"} {
		if entries, err := os.ReadDir(dir); err == nil {
			return len(entries)
		}
	}
	t.Skip("cannot count open descriptors here")
	return 0
}

// #6821 (Codex Test #6796): a session whose process ends on its own left its PTY master open until something killed it, one descriptor per scheduled run that ended naturally (about 144 a day for a 10-minute
// cron). After the exit and the drain every one of those sessions' terminals is closed. It watches each session's own PTY master, not the process's descriptor count, which moves with whatever else the
// package's goroutines open and close (#15681, as #15679).
func TestSessionsThatEndOnTheirOwnLeaveNoDescriptorsOpen(t *testing.T) {
	canFork(t)
	backend := NewPTYBackend()
	defer backend.Close()

	// descriptors of the process's own that stay open for the whole test, as another test's or goroutine's would: a whole-process count could not tell them from a terminal left open
	for i := 0; i < 6; i++ {
		f, err := os.Open(os.DevNull)
		require.NoError(t, err)
		defer f.Close()
	}
	const runs = 12
	var terminals []*os.File
	for i := 0; i < runs; i++ {
		name := fmt.Sprintf("fd-%d", i)
		require.NoError(t, backend.Spawn(name, "test", t.TempDir(), fmt.Sprintf("sid-fd-%d", i), "true", 80, 24))
		terminals = append(terminals, ownTerminal(t, backend, name))
	}
	open := func() int {
		n := 0
		for _, f := range terminals {
			if isOpen(f) {
				n++
			}
		}
		return n
	}
	require.Eventually(t, func() bool { return open() == 0 }, 2*time.Minute, 100*time.Millisecond,
		"terminals still open after %d sessions ended on their own: %d", runs, open())
}

// ownTerminal is the session's own PTY master: the one descriptor this test is about. Counting every descriptor of the process instead moves with whatever else the package's goroutines and earlier tests
// open and close (an earlier session's kill finishing during the test read "12 is not greater than 12" under load, #15679).
func ownTerminal(t *testing.T, b *PTYBackend, name string) *os.File {
	t.Helper()
	b.mu.RLock()
	s := b.sessions[name]
	b.mu.RUnlock()
	require.NotNil(t, s, "session %q", name)
	p, ok := s.proc.(*unixPTY)
	require.True(t, ok, "a Unix session's process handle is its PTY")
	return p.ptyFile
}

// isOpen: the descriptor is still held (fstat on it works); a descriptor Coral closed answers os.ErrClosed.
func isOpen(f *os.File) bool {
	_, err := f.Stat()
	return !errors.Is(err, os.ErrClosed)
}

// Security's #6826 LOW (the exit watcher's own case): the shell exits but a child it left behind keeps the terminal open, so readLoop never sees the end of the output. The descriptor is closed by the watcher after
// the drain, while that child is still running. On Unix this does not tell the watcher's close from readLoop's (removing the watcher's alone still passes): the guardian ends what the shell left behind (its group and the
// processes carrying its run tag) as the shell exits, so the output ends and readLoop frees the descriptor first. The case the watcher exists for is Windows, whose pseudo console's pipe only ends when it is closed:
// this test pins the outcome there too (Security Reviewer Windows runs it) and documents why the Unix run cannot.
// It watches the session's own terminal descriptor, not the process's descriptor count (#15679).
func TestADescriptorIsFreedWhenTheShellExitsButAChildKeepsTheTerminal(t *testing.T) {
	canFork(t)
	backend := NewPTYBackend()
	defer backend.Close()

	// The shell starts a sleeper with the terminal as its output, waits for the test's signal (a file), then exits. The test holds the shell until it has seen the terminal held, so how long it takes to look
	// is no race with the shell's exit; and the sleeper outlives the whole test, so what frees the descriptor is the exit and not the child's end (#7163).
	release := filepath.Join(t.TempDir(), "release")
	command := "sleep 300 & while [ ! -e '" + release + "' ]; do sleep 0.05; done; exit 0"
	require.NoError(t, backend.Spawn("fd-child", "test", t.TempDir(), "sid-fd-child", command, 80, 24))
	terminal := ownTerminal(t, backend, "fd-child")
	assert.True(t, isOpen(terminal), "the session holds its terminal while it runs")
	require.NoError(t, os.WriteFile(release, []byte("go"), 0o644))
	require.Eventually(t, func() bool { return !isOpen(terminal) }, 2*time.Minute, 50*time.Millisecond,
		"the session's terminal is still open after its shell exited, while the left-behind child still runs")
}

// #15679: what the test above watches does not move with other descriptors. A process that opens and closes descriptors around the session (an earlier test's kill finishing, any goroutine) changes a whole-process
// count both ways; the session's own terminal is open while it runs and closed after, whatever else comes and goes.
func TestTheSessionsOwnTerminalIsWatchedNotTheProcessDescriptorCount(t *testing.T) {
	canFork(t)
	backend := NewPTYBackend()
	defer backend.Close()
	var others []*os.File
	for i := 0; i < 6; i++ { // descriptors that are open when a count is taken and gone by the time the session holds its own
		f, err := os.Open(os.DevNull)
		require.NoError(t, err)
		others = append(others, f)
	}
	counted := openFDs(t)
	release := filepath.Join(t.TempDir(), "release")
	require.NoError(t, backend.Spawn("fd-own", "test", t.TempDir(), "sid-fd-own", "while [ ! -e '"+release+"' ]; do sleep 0.05; done; exit 0", 80, 24))
	for _, f := range others {
		f.Close()
	}
	assert.LessOrEqual(t, openFDs(t), counted, "other descriptors went while the session came: a whole-process count does not show the session's terminal held")
	terminal := ownTerminal(t, backend, "fd-own")
	assert.True(t, isOpen(terminal), "yet the session's own terminal is open while it runs")
	require.NoError(t, os.WriteFile(release, []byte("go"), 0o644))
	require.Eventually(t, func() bool { return !isOpen(terminal) }, 2*time.Minute, 50*time.Millisecond, "and closed once its shell exited")
}
