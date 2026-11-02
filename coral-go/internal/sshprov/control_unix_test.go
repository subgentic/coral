//go:build !windows

package sshprov

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resetControl(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { UseControlDir("") })
}

// Sharing one SSH session per computer (#12221): the folder is the hub user's alone, the options name a socket inside it, and every hub ssh to a computer (a command and a stream) carries them; the host-key
// scan does not.
func TestControlOptionsAreOnEveryHubSSHExceptTheKeyScan(t *testing.T) {
	resetControl(t)
	if got := UseControlDir(""); got != "" || controlArgs() != nil {
		t.Fatalf("an empty folder turned sharing on: %q", got)
	}
	dir := filepath.Join(t.TempDir(), "c")
	if len(dir)+1+40+17 > maxSocketPath { // a long temp folder: the fallback under /tmp is what is used
		t.Logf("long path, expecting the /tmp fallback: %s", dir)
	}
	got := UseControlDir(dir)
	if got == "" {
		t.Fatal("sharing stayed off")
	}
	st, err := os.Lstat(got)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Fatalf("the control folder: %v %v", st, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(got) })
	want := []string{"ControlMaster=auto", "ControlPath=" + filepath.Join(got, "%C"), "ControlPersist=60"}
	joined := strings.Join(controlArgs(), " ")
	for _, w := range want {
		if !strings.Contains(joined, w) {
			t.Errorf("control args lack %q: %s", w, joined)
		}
	}
	if len(got)+1+40+17 > maxSocketPath {
		t.Errorf("a socket in %s would not fit a Unix socket's name", got)
	}
	tg, _ := ParseTarget("user@box.example.com")
	if a := strings.Join((Runner{}).baseArgv(tg), " "); !strings.Contains(a, "ControlMaster=auto") || !strings.Contains(a, "StrictHostKeyChecking=yes") {
		t.Errorf("a command's ssh: %s", a)
	}
	s, _ := NewStreamTarget(Runner{}, tg, 8420, "k")
	if a := strings.Join(s.argv(), " "); !strings.Contains(a, "ControlMaster=auto") || !strings.Contains(a, "-W 127.0.0.1:8420") || !strings.Contains(a, "StrictHostKeyChecking=yes") {
		t.Errorf("a stream's ssh: %s", a)
	}
	for _, o := range withoutStrict(append([]string{}, sshOptions...)) {
		if strings.Contains(o, "Control") {
			t.Errorf("the key scan's options share a session: %s", o)
		}
	}
	UseControlDir("")
	if controlArgs() != nil {
		t.Error("sharing did not turn off")
	}
}

// A folder that is not safe is never used: a link, one open to others is made private, and a path that is not absolute, has a space or is too long for a socket's name falls back or turns sharing off.
func TestControlFolderIsCheckedBeforeItIsTrusted(t *testing.T) {
	resetControl(t)
	base := t.TempDir()
	target := filepath.Join(base, "real")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "l")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if got := UseControlDir(link); got == link {
		t.Errorf("a link was trusted as the control folder")
	} else if got != "" {
		t.Cleanup(func() { _ = os.RemoveAll(got) })
	}
	open := filepath.Join(base, "o")
	if err := os.MkdirAll(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if got := UseControlDir(open); got == open {
		if st, _ := os.Lstat(open); st.Mode().Perm() != 0o700 {
			t.Errorf("a folder open to others was used as it was: %v", st.Mode())
		}
	}
	if got := UseControlDir("relative/dir"); got != "" {
		t.Errorf("a relative folder: %q", got)
	}
	spaced := filepath.Join(base, "has space")
	if got := UseControlDir(spaced); got == spaced {
		t.Errorf("a folder with a space: %q", got)
	} else if got != "" {
		t.Cleanup(func() { _ = os.RemoveAll(got) })
	}
	long := filepath.Join(base, strings.Repeat("d", 80))
	if got := UseControlDir(long); got == long {
		t.Errorf("a folder too long for a socket's name: %q", got)
	} else if got != "" {
		t.Cleanup(func() { _ = os.RemoveAll(got) })
	}
}
