package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestWarnUnpushedCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not in PATH")
	}

	// Create a bare repo (the "remote") and a clone with one local-only commit.
	bare := t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v in %s: %s\n%s", args, dir, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(bare, "init", "--bare", bare)

	clone := t.TempDir()
	run(clone, "clone", bare, clone)
	run(clone, "config", "user.email", "test@test")
	run(clone, "config", "user.name", "test")

	// A pushed commit: should NOT warn.
	os.WriteFile(clone+"/a.txt", []byte("a"), 0644)
	run(clone, "add", "a.txt")
	run(clone, "commit", "-m", "pushed")
	run(clone, "push", "origin", "HEAD")
	pushedSHA := run(clone, "rev-parse", "HEAD")

	// A local-only commit: should warn.
	os.WriteFile(clone+"/b.txt", []byte("b"), 0644)
	run(clone, "add", "b.txt")
	run(clone, "commit", "-m", "local only")
	localSHA := run(clone, "rev-parse", "HEAD")

	t.Run("local-only commit warns", func(t *testing.T) {
		r, w, _ := os.Pipe()
		old := os.Stderr
		os.Stderr = w
		warnUnpushedCommit("SHA "+localSHA+" on branch foo", clone)
		w.Close()
		os.Stderr = old
		var buf [4096]byte
		n, _ := r.Read(buf[:])
		out := string(buf[:n])
		if !strings.Contains(out, "warning:") || !strings.Contains(out, localSHA) {
			t.Fatalf("expected warning for local SHA, got: %q", out)
		}
	})

	t.Run("pushed commit does not warn", func(t *testing.T) {
		r, w, _ := os.Pipe()
		old := os.Stderr
		os.Stderr = w
		warnUnpushedCommit("SHA "+pushedSHA+" on branch foo", clone)
		w.Close()
		os.Stderr = old
		var buf [4096]byte
		n, _ := r.Read(buf[:])
		out := string(buf[:n])
		if strings.Contains(out, "warning:") {
			t.Fatalf("should not warn for pushed SHA, got: %q", out)
		}
	})

	t.Run("no SHA in reason does not warn", func(t *testing.T) {
		r, w, _ := os.Pipe()
		old := os.Stderr
		os.Stderr = w
		warnUnpushedCommit("just a plain message", clone)
		w.Close()
		os.Stderr = old
		var buf [4096]byte
		n, _ := r.Read(buf[:])
		out := string(buf[:n])
		if len(out) > 0 {
			t.Fatalf("should not warn when no SHA, got: %q", out)
		}
	})
}
