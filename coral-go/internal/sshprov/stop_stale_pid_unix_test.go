//go:build !windows

package sshprov

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// #15997 (the Operator's upgrade to v2.0.67): the stop ends this user's Coral from the install folder however its PID file looks. A coral.pid that names a PID that is gone, or no coral.pid at all (a Coral that
// restarted itself under a new PID), left the old Coral running, and the upgrade stopped at "did not stop within 15 s". A Coral that ignores SIGTERM is ended by the escalation (CmdKillStuck), and only this
// install folder's: a Coral of another folder and an unrelated process are left alone.
func TestStopEndsThisInstallsCoralWhateverItsPidFileSays(t *testing.T) {
	home, other := t.TempDir(), t.TempDir()
	// a program named coral (a link to sleep: ps shows the path it was run by as the first word, as it does for the real Coral; a script would show its interpreter, a copy of sleep is killed at once on a Mac)
	sleepBin, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	// alive is a process that is running: a process that died and was not waited for still answers signal 0, so ps says what it is
	alive := func(c *exec.Cmd) bool {
		out, _ := exec.Command("ps", "-p", strconv.Itoa(c.Process.Pid), "-o", "stat=").Output()
		st := strings.TrimSpace(string(out))
		return st != "" && !strings.HasPrefix(st, "Z")
	}
	mk := func(h string) string {
		root := filepath.Join(h, InstallDir, "2.0.65", "root")
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(root, "coral")
		if err := os.Symlink(sleepBin, p); err != nil && !os.IsExist(err) {
			t.Fatal(err)
		}
		return p
	}
	start := func(bin string, ignoreTerm bool) *exec.Cmd {
		pre := ""
		if ignoreTerm {
			pre = "trap '' TERM; " // an ignored signal stays ignored across exec
		}
		c := exec.Command("sh", "-c", pre+"exec \"$0\" 300", bin)
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL); _, _ = c.Process.Wait() })
		time.Sleep(300 * time.Millisecond)
		if !alive(c) {
			t.Fatalf("the stand-in for %s is not running", bin)
		}
		return c
	}
	gone := func(c *exec.Cmd) bool {
		done := make(chan struct{})
		go func() { _ = c.Wait(); close(done) }()
		select {
		case <-done:
			return true
		case <-time.After(5 * time.Second):
			return false
		}
	}
	run := func(c Command) {
		text, err := remoteText(c)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+home)
		_ = cmd.Run()
	}
	pidFile := filepath.Join(home, InstallDir, "coral.pid")

	// a stale pid file (a PID that is gone) and a live Coral under another PID
	mine := start(mk(home), false)
	foreign := start(mk(other), false)
	if err := os.WriteFile(pidFile, []byte("999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	run(CmdStopDaemon)
	if !gone(mine) {
		t.Fatal("a stale coral.pid left this install's Coral running")
	}
	if !alive(foreign) {
		t.Fatal("the stop touched a Coral of another install folder")
	}

	// no pid file at all
	_ = os.Remove(pidFile)
	mine = start(mk(home), false)
	time.Sleep(300 * time.Millisecond)
	run(CmdStopDaemon)
	if !gone(mine) {
		t.Fatal("with no coral.pid the stop left this install's Coral running")
	}

	// one that ignores SIGTERM: the stop does not end it, the escalation does
	mine = start(mk(home), true)
	time.Sleep(300 * time.Millisecond)
	run(CmdStopDaemon)
	time.Sleep(500 * time.Millisecond)
	if !alive(mine) {
		t.Fatal("the test's stand-in was meant to ignore SIGTERM")
	}
	run(CmdKillStuck)
	if !gone(mine) {
		t.Fatal("CmdKillStuck did not end a Coral that ignores SIGTERM")
	}
	if !alive(foreign) {
		t.Fatal("the escalation touched a Coral of another install folder")
	}
}
