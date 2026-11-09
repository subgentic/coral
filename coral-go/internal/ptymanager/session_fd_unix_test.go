//go:build !windows

package ptymanager

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// readFDDir reads the folder of this process's open descriptors; a variable so a test can make a read fail.
var readFDDir = os.ReadDir

// fdCount is the open descriptor count, and false when no folder of them could be read. It is safe from any goroutine (a require.Eventually condition runs in its own): it never touches *testing.T, so it can
// neither Skip nor Fatal there. A read of the folder can fail for a moment while descriptors are closing under it, so it tries a few times before it says it cannot (#14828, QA Engineer's find: t.Skip in the
// poller ended the poll's goroutine, the condition never answered, and the test failed after its two-minute ceiling).
func fdCount() (int, bool) {
	for try := 0; try < 5; try++ {
		for _, dir := range []string{"/dev/fd", "/proc/self/fd"} {
			if entries, err := readFDDir(dir); err == nil {
				return len(entries), true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return 0, false
}

// requireFDCount skips the test, once and from the test's own goroutine, on a platform where the descriptors cannot be counted at all.
func requireFDCount(t *testing.T) {
	t.Helper()
	if _, ok := fdCount(); !ok {
		t.Skip("cannot count open descriptors here")
	}
}

// openFDs is the count for the test's own goroutine: a count that cannot be read is a failure here, not a skip (the platform was checked at the start).
func openFDs(t *testing.T) int {
	t.Helper()
	n, ok := fdCount()
	if !ok {
		t.Fatal("the open descriptor count could not be read")
	}
	return n
}

// fdsAtMost is a poll condition for require.Eventually: a count that cannot be read now is "not yet", so the poll goes on.
func fdsAtMost(limit int) func() bool {
	return func() bool {
		n, ok := fdCount()
		return ok && n <= limit
	}
}

// describeFDs names what each open descriptor is (the link under /proc/self/fd), so a failed count says which descriptors were open.
func describeFDs() string {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return "(no /proc/self/fd here)"
	}
	var out []string
	for _, e := range entries {
		target, _ := os.Readlink("/proc/self/fd/" + e.Name())
		out = append(out, e.Name()+"->"+target)
	}
	return strings.Join(out, " ")
}

// settledFDs is the open descriptor count once it has stopped changing: the same value on five reads in a row, 100 ms apart. After a session ended and was drained its descriptors go in the order the
// exit watcher and the reader run them, which on a loaded machine takes longer than a fixed sleep (#7163); a count that has held still is what "the earlier session is gone" means. The ceiling only
// ends a count that never settles.
func settledFDs(t *testing.T) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	last, same := -1, 0
	for time.Now().Before(deadline) {
		n, ok := fdCount()
		if !ok {
			last, same = -1, 0
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if n == last {
			same++
		} else {
			last, same = n, 0
		}
		if same >= 5 {
			return n
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the open descriptor count never settled (last %d)", last)
	return last
}

// #6821 (Codex Test #6796): a session whose process ends on its own left its PTY master open until something killed it, one descriptor per scheduled run that ended naturally (about 144 a day for a 10-minute
// cron). After the exit and the drain the descriptor count is back where it was.
func TestSessionsThatEndOnTheirOwnLeaveNoDescriptorsOpen(t *testing.T) {
	canFork(t)
	requireFDCount(t)
	backend := NewPTYBackend()
	defer backend.Close()
	// one throwaway run first: the first spawn opens a few process-wide descriptors of its own (the guardian, /dev/ptmx's first use)
	require.NoError(t, backend.Spawn("fd-warm", "test", t.TempDir(), "sid-fd-warm", "true", 80, 24))
	before := settledFDs(t)
	beforeNames := describeFDs()

	const runs = 12
	for i := 0; i < runs; i++ {
		require.NoError(t, backend.Spawn(fmt.Sprintf("fd-%d", i), "test", t.TempDir(), fmt.Sprintf("sid-fd-%d", i), "true", 80, 24))
	}
	require.Eventually(t, fdsAtMost(before+2), 2*time.Minute, 100*time.Millisecond,
		"descriptors after %d sessions ended on their own: %d (before %d)", runs, openFDs(t), before)
	// The count is read once more as a settled value, not as one instant: a descriptor another goroutine of the test binary has open for a moment (the descendant sampler's /proc scan, an earlier test's drain) is not a session's, and a leak is a count that stays up (#14828).
	after := settledFDs(t)
	assert.LessOrEqual(t, after, before+2, "settled open count after the sessions ended: %d (before %d)\nopen now: %s\nbefore: %s", after, before, describeFDs(), beforeNames)
}

// Security's #6826 LOW (the exit watcher's own case): the shell exits but a child it left behind keeps the terminal open, so readLoop never sees the end of the output. The descriptor is closed by the watcher after
// the drain, while that child is still running. On Unix this does not tell the watcher's close from readLoop's (removing the watcher's alone still passes): the guardian ends what the shell left behind (its group and the
// processes carrying its run tag) as the shell exits, so the output ends and readLoop frees the descriptor first. The case the watcher exists for is Windows, whose pseudo console's pipe only ends when it is closed:
// this test pins the outcome there too (Security Reviewer Windows runs it) and documents why the Unix run cannot.
func TestADescriptorIsFreedWhenTheShellExitsButAChildKeepsTheTerminal(t *testing.T) {
	canFork(t)
	requireFDCount(t)
	backend := NewPTYBackend()
	defer backend.Close()
	require.NoError(t, backend.Spawn("fd-warm2", "test", t.TempDir(), "sid-fd-warm2", "true", 80, 24))
	before := settledFDs(t)

	// The shell starts a sleeper with the terminal as its output, waits for the test's signal (a file), then exits. The test holds the shell until it has seen the terminal held, so how long it takes to look
	// is no race with the shell's exit; and the sleeper outlives the whole test, so what frees the descriptor is the exit and not the child's end (#7163).
	release := filepath.Join(t.TempDir(), "release")
	command := "sleep 300 & while [ ! -e '" + release + "' ]; do sleep 0.05; done; exit 0"
	require.NoError(t, backend.Spawn("fd-child", "test", t.TempDir(), "sid-fd-child", command, 80, 24))
	assert.Greater(t, openFDs(t), before, "the session holds its terminal while it runs")
	require.NoError(t, os.WriteFile(release, []byte("go"), 0o644))
	require.Eventually(t, fdsAtMost(before+1), 2*time.Minute, 50*time.Millisecond,
		"descriptors while the left-behind child still runs: %d (before %d)", openFDs(t), before)
}

// QA Engineer's find on #14828: a folder read that fails for a moment, inside the poll, must be "not yet", never a skip that ends the poll's goroutine and leaves the test to fail after its ceiling.
func TestAFailedDescriptorFolderReadIsRetriedNotASkip(t *testing.T) {
	real := readFDDir
	defer func() { readFDDir = real }()
	var mu sync.Mutex
	failures := 7 // more than one fdCount's own tries: the first two polls see nothing
	readFDDir = func(name string) ([]os.DirEntry, error) {
		mu.Lock()
		defer mu.Unlock()
		if failures > 0 {
			failures--
			return nil, fmt.Errorf("read %s: transient", name)
		}
		return real(name)
	}
	// the start of a real test: a transient failure must neither skip it nor make the count unreadable. fdCount is asked directly first: a skip is not a failure (#14868, mutant C: a fdCount that tries
	// once makes requireFDCount skip, and a skipped test passes).
	if _, ok := fdCount(); !ok {
		t.Fatal("a folder read that fails for a moment made the count unreadable at the start: fdCount must try again")
	}
	mu.Lock()
	failures = 7
	mu.Unlock()
	requireFDCount(t) // and the helper itself must not skip on it either (it would skip the whole test)
	mu.Lock()
	failures = 12
	mu.Unlock()
	require.Eventually(t, fdsAtMost(1<<20), 20*time.Second, 20*time.Millisecond, "the poll goes on past reads that failed")
	// (#14868, mutant A) while every read fails the condition is "not yet", never true: a count that could not be read is not a count of 0 (which is at most any limit).
	mu.Lock()
	failures = 1 << 30
	mu.Unlock()
	assert.False(t, fdsAtMost(1<<20)(), "a failed read is not a count: the condition must not be true while reads fail")
	// (#14868, mutant B) the settled count ignores failed reads: with reads failing for about two seconds, five failed reads in a row must not settle as a count of 0.
	mu.Lock()
	failures = 200
	mu.Unlock()
	assert.Greater(t, settledFDs(t), 0, "the settled count survives failed reads, and does not take five failures in a row for a count")
}
