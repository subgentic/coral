//go:build !windows

package sshprov

import (
	"context"
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

// ensurePrivateDir is the safety check of the shared socket's folder, tested directly (QA: through UseControlDir a long temp path fell back before the check was reached): a folder open to others is made 0700,
// a link is refused, and a folder owned by another user is refused.
func TestEnsurePrivateDirChecksTheFolderBeforeItIsTrusted(t *testing.T) {
	base := t.TempDir()
	open := filepath.Join(base, "open")
	if err := os.MkdirAll(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(open); err != nil {
		t.Fatalf("a folder of ours open to others: %v", err)
	}
	if st, _ := os.Lstat(open); st.Mode().Perm() != 0o700 {
		t.Errorf("it was used as it was: %v", st.Mode())
	}
	fresh := filepath.Join(base, "fresh")
	if err := ensurePrivateDir(fresh); err != nil {
		t.Fatalf("a new folder: %v", err)
	}
	if st, _ := os.Lstat(fresh); !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Errorf("a new folder is not 0700: %v", st.Mode())
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(open, link); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(link); err == nil {
		t.Error("a link was trusted as the control folder")
	}
	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(file); err == nil {
		t.Error("a file was trusted as the control folder")
	}
	if os.Getuid() != 0 {
		for _, d := range []string{"/usr", "/etc"} { // folders that exist and are owned by root
			if st, err := os.Lstat(d); err == nil && st.IsDir() {
				if err := ensurePrivateDir(d); err == nil {
					t.Errorf("%s, owned by another user, was trusted", d)
				}
				break
			}
		}
	}
}

// UseControlDir settles on a short, safe folder and refuses the rest, with a SHORT folder so the checks are what decide (a long temp path would fall back before them): a relative path, a space or a quote in
// the name, and a path too long for a socket's name (which falls back to the folder under /tmp).
func TestUseControlDirRefusesWhatItShould(t *testing.T) {
	resetControl(t)
	short, err := os.MkdirTemp("/tmp", "cs")
	if err != nil {
		t.Skip("no short folder under /tmp")
	}
	t.Cleanup(func() { _ = os.RemoveAll(short) })
	if got := UseControlDir(filepath.Join(short, "ok")); got != filepath.Join(short, "ok") {
		t.Fatalf("a short, safe folder was not used: %q", got)
	}
	for _, bad := range []string{"relative/dir", filepath.Join(short, "has space"), filepath.Join(short, `q"uote`), filepath.Join(short, "q'uote")} {
		got := UseControlDir(bad)
		if got == bad || got == "relative/dir" {
			t.Errorf("%q was used", bad)
		}
		if got != "" {
			t.Cleanup(func() { _ = os.RemoveAll(got) })
		}
	}
	long := filepath.Join(short, strings.Repeat("d", 80))
	if got := UseControlDir(long); got == long {
		t.Errorf("a folder too long for a socket's name was used")
	} else {
		if got == "" || !strings.HasPrefix(got, "/tmp/coral-ssh-") {
			t.Errorf("the fallback: %q", got)
		}
		t.Cleanup(func() { _ = os.RemoveAll(got) })
	}
	if _, err := os.Stat(long); err == nil {
		t.Error("the too-long folder was made")
	}
}

// Forgetting a host key closes the shared session to that computer (#12221, Security): ssh -O exit with the same ControlPath and the same pinned options, and nothing at all when sharing is off.
func TestCloseSharedAsksTheMasterToExitAndOnlyWhenSharing(t *testing.T) {
	resetControl(t)
	dir := t.TempDir()
	log := filepath.Join(dir, "argv.log")
	fake := filepath.Join(dir, "ssh")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho \"$@\" >> '"+log+"'\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	tg, _ := ParseTarget("user@box.example.com")
	r := Runner{SSH: fake, KnownHosts: filepath.Join(dir, "kh")}
	r.CloseShared(context.Background(), tg)
	if _, err := os.Stat(log); err == nil {
		t.Fatal("ssh was started with sharing off")
	}
	got := UseControlDir(filepath.Join(dir, "c"))
	if got == "" {
		t.Fatal("sharing stayed off")
	}
	t.Cleanup(func() { _ = os.RemoveAll(got) })
	r.CloseShared(context.Background(), tg)
	b, _ := os.ReadFile(log)
	line := string(b)
	for _, want := range []string{"-O exit", "ControlPath=" + filepath.Join(got, "%C"), "StrictHostKeyChecking=yes", "UserKnownHostsFile=" + filepath.Join(dir, "kh"), "user@box.example.com"} {
		if !strings.Contains(line, want) {
			t.Errorf("the close lacks %q: %s", want, line)
		}
	}
}
