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

// The real shell text of the daemon commands (#12217), run in sh with a fake coral that stays up: the start leaves a PID in coral.pid that is the Coral's own, the output goes to coral.log, a second start does
// nothing, a stop ends exactly that process, and a PID file that names an unrelated live process is neither taken for Coral nor signalled.
func TestDaemonCommandsInARealShell(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, InstallDir, "2.0.10", "root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	fake := "#!/bin/sh\necho \"started $*\"\ntrap 'kill $!; exit 0' TERM\nsleep 120 &\nwait\n"
	if err := os.WriteFile(filepath.Join(root, "coral"), []byte(fake), 0o700); err != nil {
		t.Fatal(err)
	}
	run := func(c Command, args ...string) int {
		text, err := remoteText(c, args...)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+home)
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				return ee.ExitCode()
			}
			t.Fatal(err)
		}
		return 0
	}
	pidOf := func() int {
		for i := 0; i < 100; i++ {
			if b, err := os.ReadFile(filepath.Join(home, InstallDir, "coral.pid")); err == nil && len(strings.TrimSpace(string(b))) > 0 {
				var n int
				for _, r := range strings.TrimSpace(string(b)) {
					n = n*10 + int(r-'0')
				}
				return n
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("no coral.pid")
		return 0
	}
	alive := func(pid int) bool { return syscall.Kill(pid, 0) == nil }
	t.Cleanup(func() {
		if b, err := os.ReadFile(filepath.Join(home, InstallDir, "coral.pid")); err == nil {
			_ = exec.Command("sh", "-c", "kill "+strings.TrimSpace(string(b))+" 2>/dev/null; true").Run()
		}
	})

	// a log over 10 MiB is moved aside at a start, so it never grows without bound
	big := filepath.Join(home, InstallDir, "coral.log")
	if err := os.WriteFile(big, make([]byte, 11<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run(CmdStartDaemon, "2.0.10", "pty", "@keep"); code != 0 {
		t.Fatalf("start exited %d", code)
	}
	if st, err := os.Stat(big + ".1"); err != nil || st.Size() != 11<<20 {
		t.Errorf("the large log was not moved aside: %v %v", st, err)
	}
	pid := pidOf()
	if !alive(pid) {
		t.Fatal("the recorded PID is not alive")
	}
	for i := 0; i < 100; i++ { // the log holds what Coral printed, with the fixed arguments
		if b, _ := os.ReadFile(filepath.Join(home, InstallDir, "coral.log")); strings.Contains(string(b), "--host 127.0.0.1 --port 8420 --no-browser --cloud-url off --backend") && strings.Contains(string(b), "--home "+filepath.Join(home, InstallDir, "data")) {
			break
		} else if i == 99 {
			t.Fatalf("coral.log: %q", b)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if run(CmdStartDaemon, "2.0.10", "pty", "@keep") != 0 || pidOf() != pid {
		t.Error("a second start started another Coral")
	}
	if run(CmdCheckPort) != 0 {
		t.Error("this user's own live Coral counted as a port held by another")
	}
	if code := run(CmdStopDaemon); code != 0 {
		t.Fatalf("stop exited %d", code)
	}
	for i := 0; i < 100 && alive(pid); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if alive(pid) {
		t.Error("stop did not end the recorded process")
	}

	// a PID file that names an unrelated live process: not Coral, so not signalled, and a start goes ahead
	other := exec.Command("sleep", "60")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Process.Kill(); _, _ = other.Process.Wait() }()
	if err := os.WriteFile(filepath.Join(home, InstallDir, "coral.pid"), []byte(strconv.Itoa(other.Process.Pid)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run(CmdStopDaemon); code != 0 {
		t.Fatalf("stop exited %d", code)
	}
	time.Sleep(200 * time.Millisecond)
	if syscall.Kill(other.Process.Pid, 0) != nil {
		t.Error("a stop signalled an unrelated process whose PID was in coral.pid")
	}
}
