//go:build windows

package ptymanager

import (
	"fmt"
	"testing"
	"time"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/naming"
)

var procGetProcessHandleCount = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessHandleCount")

// handleCount is the number of handles this process holds (the Windows counterpart of counting open descriptors).
func handleCount(t *testing.T) int {
	t.Helper()
	var n uint32
	r, _, err := procGetProcessHandleCount.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&n)))
	require.NotZero(t, r, "GetProcessHandleCount: %v", err)
	return int(n)
}

// steadyHandleCount reads the handle count once it has not changed for quiet, so sessions that earlier tests of the package left closing (a ping that outlasts its test, an exit watcher still in its drain) are
// not counted as the batch's own (#20081). It waits at most limit and then returns the latest count: a count that never settles is logged, and the test's own limit still decides.
func steadyHandleCount(t *testing.T, quiet, limit time.Duration) int {
	t.Helper()
	last, since := handleCount(t), time.Now()
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
		if n := handleCount(t); n != last {
			last, since = n, time.Now()
		} else if time.Since(since) >= quiet {
			return last
		}
	}
	t.Logf("the handle count did not settle for %v within %v: using %d", quiet, limit, last)
	return last
}

// A session is given a full command line here (Spawn does not wrap it in a shell on Windows: a bare cmdlet name is "The system cannot find the file specified").
const exitNow = "powershell.exe -NoProfile -Command exit"

// #6821 on Windows (measured on a Windows runner, #6827): a session whose process ends on its own must be closed like a killed one, or each leaves a pseudo console, its pipes and the job object open
// (about 10 handles a session without the fix, none with it). The count is not flat from the first session: the first batch of ConPTY sessions costs the process a one-time ~9 handles a session (runtime
// threads and their events), so a first batch of sessions that end on their own warms the process up, and the second batch of the same kind may add no more than four handles a session (measured: 14 for 8 sessions with the fix, 80 to 128 without it).
func TestASecondBatchOfSessionsThatEndOnTheirOwnAddsNoHandles(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	const runs = 8
	backend := NewPTYBackend()
	defer backend.Close()
	// A batch is counted once every session in it has ended and its exit watcher has had the drain to close it, not after a fixed
	// time: on a busy machine a PowerShell can take longer than the old 6 s to start and exit, and a session still running holds its
	// pseudo console, which read as up to 61 "leaked" handles (#370). The limit below is unchanged.
	batch := func(tag string) {
		names := make([]string, runs)
		for i := range names {
			names[i] = fmt.Sprintf("hd-%s%d", tag, i)
			require.NoError(t, backend.Spawn(names[i], "test", t.TempDir(), fmt.Sprintf("sid-hd-%s%d", tag, i), exitNow, 120, 40))
		}
		require.Eventually(t, func() bool {
			for _, n := range names {
				if backend.IsRunning(n) {
					return false
				}
			}
			return true
		}, 90*time.Second, 100*time.Millisecond, "the %s batch's sessions did not all end", tag)
		time.Sleep(exitDrain + time.Second) // the exit watcher closes each pseudo console after the drain
	}
	batch("a") // the first batch pays the one-time cost
	before := steadyHandleCount(t, 3*time.Second, 60*time.Second)
	batch("b")
	// The count is read until it settles, not once after the fixed sleep (#20081): on a loaded runner the second batch's exit watchers were still closing handles when the sleep ended (36 against the limit of 32 on one run, fine on the next).
	// A leak never comes back down, so it still fails when the wait ends; the limit stays at four handles a session.
	added, settled := 0, false
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); time.Sleep(time.Second) {
		if added = handleCount(t) - before; added <= runs*4 {
			settled = true
			break
		}
	}
	t.Logf("handles: baseline %d, after the second batch %d, added %d (%d sessions that ended on their own)", before, before+added, added, runs)
	assert.True(t, settled, "a second batch of %d sessions that ended on their own still held %d more handles after 90 s: something is left open for each", runs, added)
}

// The shell exits but a program it started keeps running: the exit watcher still closes the pseudo console after the drain, while that program lives (a pseudo console's output pipe only ends when it is
// closed). Measured on the Windows runner: fails on the parent of the fix (266 handles against 255), passes with it.
func TestHandlesAreFreedWhenTheShellExitsButAChildRuns(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	backend := NewPTYBackend()
	defer backend.Close()
	require.NoError(t, backend.Spawn("hd-warm2", "test", t.TempDir(), "sid-hd-warm2", exitNow, 120, 40))
	time.Sleep(exitDrain + 3*time.Second)
	before := handleCount(t)

	// the shell starts a hidden ping that runs for ~12 s and exits at once
	cmd := "powershell.exe -NoProfile -Command Start-Process ping -ArgumentList '-n','12','127.0.0.1' -WindowStyle Hidden"
	require.NoError(t, backend.Spawn("hd-child", "test", t.TempDir(), "sid-hd-child", cmd, 120, 40))
	assert.Eventually(t, func() bool { return handleCount(t) <= before+4 }, 9*time.Second, 250*time.Millisecond,
		"handles while the left-behind program still runs: %d (before %d)", handleCount(t), before)
}
