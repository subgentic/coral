//go:build darwin

package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/startup/locktest"
)

// #19038: the tray's server child is the server a Finder, login-item or in-app-update start runs on macOS, with the system's bare PATH. It must read its user's login shell's folders as `coral` does
// (#15072), or every agent it launches has no node, go or npm. A stand-in login shell adds a folder; the child says it added it.
func TestATrayServerChildWithABarePathReadsTheLoginShellsFolders(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the program")
	}
	bin, ok := locktest.Build(t, ".")
	if !ok {
		t.Skip("coral-tray cannot be built here (it needs its platform libraries)")
	}
	f := locktest.New(t)
	shell := filepath.Join(t.TempDir(), "login-shell")
	// Run as `shell -ilc <script>`: print what that script prints, with a folder added to the PATH it sees.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nPATH=\"$PATH:/qa4-19038-login-folder\" exec /bin/sh -c \"$3\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A second server holds the data folder, so the child exits at once (as in the lock test): all this test reads is what it said first.
	hold := exec.Command(bin, "--server-child", "--port", "0")
	hold.Env = f.Env("0")
	holdIn, err := hold.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := hold.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holdIn.Close(); _ = hold.Process.Kill(); _ = hold.Wait() }()
	time.Sleep(3 * time.Second)

	cmd := exec.Command(bin, "--server-child", "--port", "0")
	cmd.Env = append(f.Env("0"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "SHELL="+shell)
	var out bytes.Buffer
	cmd.Stderr, cmd.Stdout = &out, &out
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("the tray's server child did not exit")
	}
	if !strings.Contains(out.String(), "the login shell's folders were added to its search path") {
		t.Errorf("the child with a bare PATH should add its login shell's folders: %q", out.String())
	}
}
