//go:build !windows

package sshprov

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// The stop check, run for real by sh against stand-in processes of this user (read-only: it only reads ps; each stand-in is a sleeping shell started here and killed by its PID): a Coral of THIS install folder
// running means "not stopped" (exit 2), none means stopped (0), and a process of another folder is not this user's Coral.
func TestStopCheckRunByShSeesThisUsersCoralAndNothingElse(t *testing.T) {
	if out, err := exec.Command("ps", "-u", strconv.Itoa(os.Getuid()), "-o", "args=").CombinedOutput(); err != nil || len(out) == 0 {
		t.Skipf("this machine's ps does not answer ps -u: %v", err)
	}
	home := t.TempDir()
	other := t.TempDir()
	text, err := remoteText(CmdCheckStopped)
	if err != nil {
		t.Fatal(err)
	}
	check := func() int {
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
		err := cmd.Run()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		if err != nil {
			t.Fatalf("sh: %v", err)
		}
		return 0
	}
	// a shell that stays (the ';:' keeps it from exec'ing sleep, which would replace the arguments): its arguments end with the path of a Coral and a flag, as the real one's do
	stand := func(h string) *exec.Cmd {
		c := exec.Command("sh", "-c", "sleep 300; :", filepath.Join(h, InstallDir, "9.9.9", "root", "coral"), "--host", "127.0.0.1")
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // its own group, so the sleep under the shell goes with it
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { killGroup(c) })
		return c
	}
	if got := check(); got != 0 {
		t.Fatalf("nothing running: exit %d, want 0", got)
	}
	o := stand(other)
	time.Sleep(200 * time.Millisecond)
	if got := check(); got != 0 {
		t.Errorf("a Coral of another install folder is not this user's here: exit %d, want 0", got)
	}
	mine := stand(home)
	deadline := time.Now().Add(5 * time.Second)
	got := 0
	for time.Now().Before(deadline) {
		if got = check(); got == 2 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got != 2 {
		t.Fatalf("this install folder's Coral is running: exit %d, want 2 (not stopped)", got)
	}
	killGroup(mine)
	if got := check(); got != 0 {
		t.Errorf("after that Coral is gone: exit %d, want 0", got)
	}
	killGroup(o)
}

// killGroup ends a stand-in and the sleep under it by the group that was made for them (no other process is touched), and waits for it.
func killGroup(c *exec.Cmd) {
	_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	_, _ = c.Process.Wait()
}
