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

// #16010 (Security's INFO on #15997): "this install's Coral" is exactly <install>/<one version folder>/root/coral. A program deeper in the folder that happens to end in /root/coral (a copy kept under another
// name, a checkout) is not a Coral the stop may end.
func TestStopMatchesOnlyAnInstalledReleaseAndNotAProgramDeeperInTheFolder(t *testing.T) {
	home := t.TempDir()
	sleepBin, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	alive := func(c *exec.Cmd) bool {
		out, _ := exec.Command("ps", "-p", strconv.Itoa(c.Process.Pid), "-o", "stat=").Output()
		st := strings.TrimSpace(string(out))
		return st != "" && !strings.HasPrefix(st, "Z")
	}
	start := func(rel ...string) *exec.Cmd {
		root := filepath.Join(append([]string{home, InstallDir}, rel...)...)
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		bin := filepath.Join(root, "coral")
		if err := os.Symlink(sleepBin, bin); err != nil {
			t.Fatal(err)
		}
		c := exec.Command("sh", "-c", "exec \"$0\" 300", bin)
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL); _, _ = c.Process.Wait() })
		return c
	}
	startAs := func(rel string) *exec.Cmd { // a program named by a path spelled as given, with "." or ".." as the folder: the real file is where it leads
		real := filepath.Dir(filepath.Join(home, InstallDir, rel)) // where the spelled path really leads
		if err := os.MkdirAll(real, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(sleepBin, filepath.Join(real, "coral")); err != nil && !os.IsExist(err) {
			t.Fatal(err)
		}
		c := exec.Command("sh", "-c", "exec \"$0\" 300", home+"/"+InstallDir+"/"+rel)
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL); _, _ = c.Process.Wait() })
		return c
	}
	dot := startAs("./root/coral")              // <install>/./root/coral: the one folder is "." (#16041)
	dotdot := startAs("../root/coral")          // <install>/../root/coral
	nested := start("backup", "2.0.60", "root") // <install>/backup/2.0.60/root/coral
	mine := start("2.0.65", "root")             // <install>/2.0.65/root/coral
	time.Sleep(400 * time.Millisecond)
	for _, c := range []Command{CmdStopDaemon, CmdKillStuck} {
		text, err := remoteText(c)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+home)
		_ = cmd.Run()
	}
	time.Sleep(500 * time.Millisecond)
	if alive(mine) {
		t.Fatal("the installed release was not stopped")
	}
	for name, c := range map[string]*exec.Cmd{"<install>/./root/coral": dot, "<install>/../root/coral": dotdot} {
		if !alive(c) {
			t.Fatalf("the stop ended a program at %s: \".\" and \"..\" are not a version folder", name)
		}
	}
	if !alive(nested) {
		t.Fatal("the stop ended a program deeper in the install folder that is not an installed release")
	}
}
