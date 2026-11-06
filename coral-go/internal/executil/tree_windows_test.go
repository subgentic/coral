//go:build windows

package executil

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

// A CLI that is a .cmd shim runs as cmd.exe /c, and the program it really runs (node.exe under claude.cmd) is cmd.exe's child. On a timeout Go ends the process it started, which
// left that child running (#349). The test shim runs a long ping, the stand-in for node.exe.

func processAlive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev == uint32(windows.WAIT_TIMEOUT)
}

// shim writes a claude.cmd-like file whose child is a ping that outlives the shim by a minute.
func shim(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "claude.cmd")
	require.NoError(t, os.WriteFile(p, []byte("@echo off\r\nping -n 60 127.0.0.1 >nul\r\n"), 0o600))
	return p
}

func pids(ms []member) []uint32 {
	var out []uint32
	for _, m := range ms {
		out = append(out, m.pid)
	}
	return out
}

// waitForDescendants waits until pid has at least n descendants and returns them.
func waitForDescendants(t *testing.T, pid int, n int) []uint32 {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if d := descendants(uint32(pid)); len(d) >= n {
			return pids(d)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("process %d never had %d descendants", pid, n)
	return nil
}

func TestATimedOutShimEndsItsWholeTree(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := Command(ctx, shim(t))
	require.NoError(t, cmd.Start())
	kids := waitForDescendants(t, cmd.Process.Pid, 1)
	cancel()
	_ = cmd.Wait()
	deadline := time.Now().Add(10 * time.Second)
	for _, k := range kids {
		for processAlive(k) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		assert.False(t, processAlive(k), "the shim's child %d is still running after the timeout", k)
	}
}

// Output and Run are the calls the probes make: no start/wait hook for the caller, so the end must come from the command itself.
func TestOutputOfATimedOutShimReturnsAtTheDeadlineAndLeavesNothingRunning(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cmd := Command(ctx, shim(t))
	start := time.Now()
	done := make(chan error, 1)
	var kids []uint32
	go func() {
		kids = waitForDescendantsQuiet(cmd, 1)
		done <- nil
	}()
	_, err := cmd.Output()
	require.Error(t, err)
	assert.Less(t, time.Since(start), 10*time.Second, "Output came back at the deadline")
	<-done
	require.NotEmpty(t, kids)
	deadline := time.Now().Add(10 * time.Second)
	for _, k := range kids {
		for processAlive(k) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		assert.False(t, processAlive(k), "the shim's child %d is still running", k)
	}
}

// waitForDescendantsQuiet polls for the started command's descendants without failing the test from another goroutine.
func waitForDescendantsQuiet(cmd *exec.Cmd, n int) []uint32 {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cmd.Process != nil {
			if d := descendants(uint32(cmd.Process.Pid)); len(d) >= n {
				return pids(d)
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	return nil
}

// A command that ends by itself is left alone: nothing it started is touched, as before.
func TestACommandThatEndsByItselfLeavesWhatItStartedRunning(t *testing.T) {
	p := filepath.Join(t.TempDir(), "spawn.cmd")
	require.NoError(t, os.WriteFile(p, []byte("@echo off\r\nstart /b ping -n 30 127.0.0.1 >nul\r\n"), 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := Command(ctx, p)
	require.NoError(t, cmd.Start())
	kids := waitForDescendants(t, cmd.Process.Pid, 1)
	require.NoError(t, cmd.Wait())
	for _, k := range kids {
		defer func(pid uint32) {
			if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid); err == nil {
				_ = windows.TerminateProcess(h, 1)
				windows.CloseHandle(h)
			}
		}(k)
	}
	time.Sleep(300 * time.Millisecond)
	alive := 0
	for _, k := range kids {
		if processAlive(k) {
			alive++
		}
	}
	assert.NotZero(t, alive, "a command that finished by itself does not end what it left running")
}

// A recycled process id must never be taken for a child: only a process created after its parent counts, and only through a chain of parents.
func TestCollectIgnoresARecycledParentId(t *testing.T) {
	t0 := time.Now()
	born := map[uint32]time.Time{10: t0, 11: t0.Add(time.Second), 12: t0.Add(-5 * time.Second), 13: t0.Add(2 * time.Second), 14: t0.Add(time.Second)}
	procs := []procEntry{{pid: 10, ppid: 1}, {pid: 11, ppid: 10}, {pid: 12, ppid: 10}, {pid: 13, ppid: 11}, {pid: 14, ppid: 99}}
	got := collect(procs, 10, func(pid uint32) (time.Time, bool) { v, ok := born[pid]; return v, ok })
	assert.ElementsMatch(t, []uint32{11, 13}, pids(got), "12 is older than its parent (a recycled id) and 14 is nobody's child")
	// A process whose age cannot be read is left alone.
	got = collect(procs, 10, func(pid uint32) (time.Time, bool) {
		if pid == 11 {
			return time.Time{}, false
		}
		v, ok := born[pid]
		return v, ok
	})
	assert.NotContains(t, pids(got), uint32(11))
}

// Kill is for a command Coral stops itself: the shim and its child both end.
func TestKillEndsTheShimAndItsChild(t *testing.T) {
	cmd := Command(context.Background(), shim(t))
	require.NoError(t, cmd.Start())
	kids := waitForDescendants(t, cmd.Process.Pid, 1)
	require.NoError(t, Kill(cmd))
	_ = cmd.Wait()
	deadline := time.Now().Add(10 * time.Second)
	for _, k := range kids {
		for processAlive(k) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		assert.False(t, processAlive(k), "the shim's child %d is still running after Kill", k)
	}
}

// A process id reused between the finding and the kill is not ended: the creation time is read again on the handle that terminates.
func TestTerminateSkipsAProcessThatIsNotTheOneFound(t *testing.T) {
	cmd := Command(context.Background(), "ping", "-n", "30", "127.0.0.1") // hidden, as every console program in these tests (the consoletest lint)
	require.NoError(t, cmd.Start())
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	pid := uint32(cmd.Process.Pid)
	born, ok := createdAt(pid)
	require.True(t, ok)
	terminate(member{pid: pid, born: born.Add(-time.Hour)}) // the id of another, older process
	time.Sleep(200 * time.Millisecond)
	assert.True(t, processAlive(pid), "a process whose creation time differs from the one found is left running")
	terminate(member{pid: pid, born: born})
	deadline := time.Now().Add(5 * time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	assert.False(t, processAlive(pid), "the one that was found is ended")
}
