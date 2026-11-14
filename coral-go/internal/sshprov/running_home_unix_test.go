//go:build !windows

package sshprov

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// #16021: the data folder a running Coral uses is read from its command line (its --home), as the stop reads the process: only a Coral of this install folder counts, and what the folder is (under the home folder,
// elsewhere, or not a path the hub can place) is said as one word with the path.
func TestReadRunningHomeSaysWhichFolderTheRunningCoralUses(t *testing.T) {
	home := t.TempDir()
	other := t.TempDir()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	// a program named coral that shows its arguments in ps (a link to sh: ps shows the path it was run by as the first word, then -c, the script and the arguments after it)
	run := func(h string, args ...string) *exec.Cmd {
		root := filepath.Join(h, InstallDir, "2.0.65", "root")
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		bin := filepath.Join(root, "coral")
		if err := os.Symlink(sh, bin); err != nil && !os.IsExist(err) {
			t.Fatal(err)
		}
		c := exec.Command(bin, append([]string{"-c", "sleep 300; sleep 0"}, args...)...)
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL); _, _ = c.Process.Wait() })
		time.Sleep(300 * time.Millisecond)
		return c
	}
	read := func() string {
		text, err := remoteText(CmdReadRunningHome)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+home)
		out, _ := cmd.Output()
		return strings.TrimSpace(string(out))
	}
	stop := func(c *exec.Cmd) { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL); _, _ = c.Process.Wait() }

	if got := read(); got != "" {
		t.Fatalf("with no Coral running it said %q", got)
	}
	// another install folder's Coral, however its --home reads, is not this one's
	foreign := run(other, "--home", other+"/theirs")
	if got := read(); got != "" {
		t.Fatalf("a Coral of another install folder was read: %q", got)
	}
	stop(foreign)

	c := run(home, "--host", "127.0.0.1", "--home", home+"/mydata/")
	if got, want := read(), "rel mydata"; got != want {
		t.Fatalf("under the home folder: %q, want %q", got, want)
	}
	stop(c)
	c = run(home, "--home="+home+"/.coral")
	if got, want := read(), "rel .coral"; got != want {
		t.Fatalf("the --home=path form: %q, want %q", got, want)
	}
	stop(c)
	c = run(home, "--home", other+"/elsewhere")
	if got, want := read(), "abs "+other+"/elsewhere"; got != want {
		t.Fatalf("outside the home folder: %q, want %q", got, want)
	}
	stop(c)
	c = run(home, "--home", "data")
	if got, want := read(), "relative data"; got != want {
		t.Fatalf("a relative --home: %q, want %q", got, want)
	}
	stop(c)
	c = run(home, "--port", "8420")
	if got := read(); got != "" {
		t.Fatalf("a Coral with no --home: %q", got)
	}
}

// A kept absolute data folder is used by the start only while it is still a Coral data folder: a recorded folder with no sessions.db is the default again, never a start in an empty or foreign folder.
func TestDataDirRecordedAsAbsoluteIsUsedOnlyWhileItIsACoralDataFolder(t *testing.T) {
	home, data := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, InstallDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, InstallDir, "datadir"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	resolve := func() string {
		out, _ := func() ([]byte, error) {
			cmd := exec.Command("sh", "-c", readDataDir+`printf %s "$h"`)
			cmd.Env = append(os.Environ(), "HOME="+home)
			return cmd.Output()
		}()
		return string(out)
	}
	if got := resolve(); got != filepath.Join(home, DefaultDataDir) {
		t.Fatalf("a folder with no sessions.db was used: %q", got)
	}
	if err := os.WriteFile(filepath.Join(data, "sessions.db"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := resolve(); got != data {
		t.Fatalf("a Coral data folder was not kept: %q, want %q", got, data)
	}
}
