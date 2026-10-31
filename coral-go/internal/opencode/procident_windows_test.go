//go:build windows

package opencode

import (
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11411: on Windows a recorded server is the process whose creation time and image are the recorded ones; anything else is never ended.
func TestWindowsAPidIsTheRecordedServerOnlyWithItsOwnStartAndImage(t *testing.T) {
	me := os.Getpid()
	start, img := processStart(me), processImage(me)
	require.NotEmpty(t, start)
	require.NotEmpty(t, img)
	assert.Equal(t, start, processStart(me), "the same text on every call")
	assert.True(t, isRecordedServer(pidRecord{PID: me, Started: start, Image: img}))
	assert.True(t, isRecordedServer(pidRecord{PID: me, Started: start, Image: upper(img)}), "a path is not told apart by its case")
	assert.False(t, isRecordedServer(pidRecord{PID: me, Started: start + "1", Image: img}), "another start time: a reused pid")
	assert.False(t, isRecordedServer(pidRecord{PID: me, Started: start, Image: img + ".other"}), "another image")
	assert.False(t, isRecordedServer(pidRecord{PID: me, Started: start}), "a record with no image is never trusted")
	assert.False(t, isRecordedServer(pidRecord{PID: me, Image: img}), "a record with no start time is never trusted")
	assert.False(t, isRecordedServer(pidRecord{PID: 1 << 30, Started: start, Image: img}), "no such process")
	assert.False(t, isRecordedServer(pidRecord{PID: 4, Started: start, Image: img}), "System is never ours")
}

func upper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

// A server that is a shim (cmd.exe running the real program) is ended with what it started: ending only the parent would leave the child holding the port.
func TestWindowsEndingAServerEndsItsChildrenToo(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "ping -n 60 127.0.0.1 > nul")
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	go func() { _ = cmd.Wait() }()
	defer cmd.Process.Kill()
	created, err := func() (uint64, error) {
		h := openProcess(pid)
		defer closeHandle(h)
		t0, ok := creation(h)
		if !ok {
			return 0, os.ErrInvalid
		}
		return t0, nil
	}()
	require.NoError(t, err)
	var kids []pidAt
	require.Eventually(t, func() bool { kids = descendants(pid, created); return len(kids) > 0 }, 10*time.Second, 100*time.Millisecond, "cmd.exe started a child")
	rec := pidRecord{PID: pid, Started: processStart(pid), Image: processImage(pid)}
	require.True(t, isRecordedServer(rec))

	endProcess(pid)
	require.Eventually(t, func() bool { return processStart(pid) == "" }, 10*time.Second, 100*time.Millisecond, "the server is gone")
	for _, k := range kids {
		k := k
		require.Eventually(t, func() bool { return processStart(k.pid) == "" }, 10*time.Second, 100*time.Millisecond, "its child "+strconv.Itoa(k.pid)+" is gone")
	}
}

// Stopping a server Coral started ends its children too, at once: a shim's child must not keep the port after a normal stop.
func TestWindowsStopEndsAShimServersChildrenToo(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "ping -n 60 127.0.0.1 > nul")
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	s := &Server{cmd: cmd, dir: t.TempDir(), done: make(chan struct{}), started: processStart(pid), image: processImage(pid)}
	go func() { defer close(s.done); _ = cmd.Wait() }()
	h := openProcess(pid)
	created, ok := creation(h)
	closeHandle(h)
	require.True(t, ok)
	var kids []pidAt
	require.Eventually(t, func() bool { kids = descendants(pid, created); return len(kids) > 0 }, 10*time.Second, 100*time.Millisecond, "cmd.exe started a child")

	start := time.Now()
	s.Stop()
	assert.Less(t, time.Since(start), 2500*time.Millisecond, "ended at once, not after the 3 s a signal is given")
	for _, k := range kids {
		k := k
		require.Eventually(t, func() bool { return processStart(k.pid) == "" }, 10*time.Second, 100*time.Millisecond, "its child "+strconv.Itoa(k.pid)+" is gone")
	}
}

// A server that ended on its own while its pid is now another live process's is never ended by Stop (a pid is reused): not by Stop, which sees it is done, and not by askToEnd, which sees the process is not the one
// that was started.
func TestWindowsAnExitedServersPidHeldByAnotherProcessIsNotEnded(t *testing.T) {
	gone := exec.Command("cmd.exe", "/c", "exit 0")
	require.NoError(t, gone.Start())
	goneStart, goneImage := processStart(gone.Process.Pid), processImage(gone.Process.Pid)
	_ = gone.Wait()

	other := exec.Command("cmd.exe", "/c", "ping -n 60 127.0.0.1 > nul")
	require.NoError(t, other.Start())
	go func() { _ = other.Wait() }()
	defer other.Process.Kill()
	otherPid := other.Process.Pid
	require.NotEmpty(t, processStart(otherPid))
	// the server record is the exited one's (its start time and image), the pid is the other process's, as after a reuse
	impostor, err := os.FindProcess(otherPid)
	require.NoError(t, err)
	s := &Server{cmd: &exec.Cmd{Process: impostor}, dir: t.TempDir(), done: make(chan struct{}), started: goneStart, image: goneImage}

	askToEnd(s) // the process is not the one that was started: nothing is ended
	time.Sleep(500 * time.Millisecond)
	assert.NotEmpty(t, processStart(otherPid), "askToEnd did not end a process that is not the server")

	close(s.done) // the server's own wait has returned: Stop asks nothing of the pid
	s.Stop()
	time.Sleep(500 * time.Millisecond)
	assert.NotEmpty(t, processStart(otherPid), "Stop did not end it either")
}
