//go:build !windows

package sshprov

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The port the far Coral listens on is the person's choice (#13081): 1024 to 65535, given to Coral as --port and to the port check and the holder lookup, never 8420 written into them.
func TestPortsAreOnlyAPlainNumberFrom1024To65535(t *testing.T) {
	for _, ok := range []int{1024, 8420, 8461, 65535} {
		if !ValidPort(ok) {
			t.Errorf("%d should be allowed", ok)
		}
		if _, err := remoteText(CmdCheckPort, strconv.Itoa(ok)); err != nil {
			t.Errorf("%d is refused as an argument: %v", ok, err)
		}
	}
	for _, bad := range []int{0, 80, 1023, 65536, 99999, -1} {
		if ValidPort(bad) {
			t.Errorf("%d should be refused", bad)
		}
	}
	for _, bad := range []string{"", "0", "80", "1023", "65536", "99999", "08420", "+8420", "8420 ", "8420;ls", "$PORT", "8.4", "-8420", "8420\n"} {
		for _, c := range []Command{CmdCheckPort, CmdPortHolder} {
			if _, err := remoteText(c, bad); err == nil {
				t.Errorf("command %d took the argument %q", c, bad)
			}
		}
		if _, err := remoteText(CmdStartDaemon, "2.0.10", "pty", "@keep", bad); err == nil {
			t.Errorf("the start took the port %q", bad)
		}
	}
	if err := (Runner{}).StartOn(nil, Target{}, "2.0.10", "pty", "", 80); err != ErrNotAllowed {
		t.Errorf("a start on port 80 was not refused before anything ran: %v", err)
	}
}

// The start gives Coral the chosen port, in a real shell.
func TestStartGivesCoralTheChosenPort(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, InstallDir, "2.0.10", "root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "coral"), []byte("#!/bin/sh\necho \"started $*\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	text, err := remoteText(CmdStartDaemon, "2.0.10", "pty", ".coral-server/data", "8461")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", text)
	cmd.Env = append(os.Environ(), "HOME="+home)
	_ = cmd.Run()
	for i := 0; i < 100; i++ {
		if b, _ := os.ReadFile(filepath.Join(home, InstallDir, "coral.log")); strings.Contains(string(b), "--host 127.0.0.1 --port 8461 --no-browser") {
			if strings.Contains(string(b), "--port 8420") {
				t.Fatalf("the default port is in the start line: %s", b)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("Coral was not started with --port 8461")
}

// The port check looks at the port asked for: one held on 8461 is refused on 8461 and not on another (Linux reads /proc/net/tcp; elsewhere the check cannot tell and says so, exit 3).
func TestPortCheckLooksAtTheChosenPort(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	held := l.Addr().(*net.TCPAddr).Port
	if !ValidPort(held) {
		t.Skip("the system gave a port below 1024")
	}
	other := held + 1
	if other > 65535 || !ValidPort(other) {
		other = held - 1
	}
	run := func(port int) int {
		text, err := remoteText(CmdCheckPort, strconv.Itoa(port))
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+t.TempDir())
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				return ee.ExitCode()
			}
			t.Fatal(err)
		}
		return 0
	}
	if runtime.GOOS != "linux" {
		if got := run(held); got != 3 {
			t.Errorf("without /proc/net/tcp the check says %d, want 3 (cannot tell)", got)
		}
		return
	}
	if got := run(held); got != 2 {
		t.Errorf("a held port %d was not refused: exit %d", held, got)
	}
	if got := run(other); got != 0 {
		t.Errorf("a free port %d was refused: exit %d", other, got)
	}
}
