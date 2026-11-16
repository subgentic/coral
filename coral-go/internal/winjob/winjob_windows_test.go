//go:build windows

package winjob

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The test binary is its own forking command: run with WINJOB_ROLE=parent it starts two children (itself, role=sleeper) and writes every pid to WINJOB_PIDS, then sleeps too.
func TestMain(m *testing.M) {
	switch os.Getenv("WINJOB_ROLE") {
	case "sleeper":
		time.Sleep(10 * time.Minute)
		return
	case "marker":
		_ = os.WriteFile(os.Getenv("WINJOB_MARKER"), []byte("ran"), 0o600)
		return
	case "parent":
		var pids []string
		for i := 0; i < 2; i++ {
			c := exec.Command(os.Args[0])
			c.Env = append(os.Environ(), "WINJOB_ROLE=sleeper")
			if err := c.Start(); err != nil {
				os.Exit(3)
			}
			pids = append(pids, strconv.Itoa(c.Process.Pid))
		}
		pids = append(pids, strconv.Itoa(os.Getpid()))
		_ = os.WriteFile(os.Getenv("WINJOB_PIDS"), []byte(strings.Join(pids, "\n")), 0o600)
		time.Sleep(10 * time.Minute)
		return
	}
	os.Exit(m.Run())
}

func alive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev == uint32(windows.WAIT_TIMEOUT)
}

func startForker(t *testing.T, j *Job) (*exec.Cmd, []uint32) {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "pids")
	c := exec.Command(os.Args[0])
	c.Env = append(os.Environ(), "WINJOB_ROLE=parent", "WINJOB_PIDS="+pidFile)
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	if err := j.Assign(c); err != nil {
		t.Fatal(err)
	}
	var pids []uint32
	for dl := time.Now().Add(10 * time.Second); time.Now().Before(dl); time.Sleep(50 * time.Millisecond) {
		b, err := os.ReadFile(pidFile)
		if err != nil || len(strings.Fields(string(b))) < 3 {
			continue
		}
		for _, f := range strings.Fields(string(b)) {
			n, _ := strconv.Atoi(f)
			pids = append(pids, uint32(n))
		}
		break
	}
	if len(pids) != 3 {
		t.Fatal("the command did not fork its children")
	}
	for _, p := range pids {
		if !alive(p) {
			t.Fatalf("pid %d should be running before the stop", p)
		}
	}
	return c, pids
}

func allGone(pids []uint32, within time.Duration) []uint32 {
	var left []uint32
	for dl := time.Now().Add(within); ; time.Sleep(100 * time.Millisecond) {
		left = left[:0]
		for _, p := range pids {
			if alive(p) {
				left = append(left, p)
			}
		}
		if len(left) == 0 || time.Now().After(dl) {
			return left
		}
	}
}

// #17603: a run that forks children dies whole within 10 s of a stop: the command and both children, no stray process.
func TestStopKillsTheWholeTree(t *testing.T) {
	j, err := New(Default)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	c, pids := startForker(t, j)
	defer c.Process.Kill()
	if err := j.Kill(); err != nil {
		t.Fatal(err)
	}
	if left := allGone(pids, 10*time.Second); len(left) > 0 {
		t.Fatalf("still running 10 s after the stop: %v", left)
	}
}

// #17603: the owner of the job going away (a dropped connection, a killed coral-board) ends the whole tree too: closing the handle is what the OS does for a dead process.
func TestDroppedOwnerKillsTheWholeTree(t *testing.T) {
	j, err := New(Default)
	if err != nil {
		t.Fatal(err)
	}
	c, pids := startForker(t, j)
	defer c.Process.Kill()
	j.Close()
	if left := allGone(pids, 10*time.Second); len(left) > 0 {
		t.Fatalf("still running 10 s after the owner went: %v", left)
	}
}

// The process cap holds: a job limited to two live processes cannot start a third.
func TestProcessCapStopsAFork(t *testing.T) {
	j, err := New(Limits{Processes: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	pidFile := filepath.Join(t.TempDir(), "pids")
	c := exec.Command(os.Args[0])
	c.Env = append(os.Environ(), "WINJOB_ROLE=parent", "WINJOB_PIDS="+pidFile)
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer c.Process.Kill()
	if err := j.Assign(c); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	if _, err := os.Stat(pidFile); err == nil {
		t.Fatal("the parent started both children past a cap of two processes")
	}
}

// #17721: a command started Suspended runs nothing until Resume, so it is in the job before it can fork a child outside it. Failing-first: before Suspended existed, the command ran as it started.
func TestASuspendedCommandRunsNothingUntilItIsInTheJobAndResumed(t *testing.T) {
	j, err := New(Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	marker := filepath.Join(t.TempDir(), "ran")
	c := exec.Command(os.Args[0])
	c.Env = append(os.Environ(), "WINJOB_ROLE=marker", "WINJOB_MARKER="+marker)
	Suspended(c)
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Process.Kill(); _ = c.Wait() }()
	time.Sleep(700 * time.Millisecond) // sleep-ok: nothing may run in this time; there is no event to wait for
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the command ran before it was resumed")
	}
	if err := j.Assign(c); err != nil {
		t.Fatal(err)
	}
	if err := Resume(c); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(marker); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond) // sleep-ok: polling for the file the resumed command writes
	}
	t.Fatal("the resumed command never ran")
}
