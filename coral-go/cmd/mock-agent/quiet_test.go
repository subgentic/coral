package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// captured runs f and returns what it wrote to stdout and stderr.
func captured(t *testing.T, f func()) (out, errOut string) {
	t.Helper()
	ro, wo, _ := os.Pipe()
	re, we, _ := os.Pipe()
	so, se := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = wo, we
	f()
	os.Stdout, os.Stderr = so, se
	wo.Close()
	we.Close()
	a, _ := io.ReadAll(ro)
	b, _ := io.ReadAll(re)
	return string(a), string(b)
}

// MOCK_AGENT_QUIET=1 (#13180): the helpers print nothing, and unset they print what the lines always did.
func TestQuietModeSilencesTheMockLines(t *testing.T) {
	t.Setenv("MOCK_AGENT_QUIET", "")
	out, errOut := captured(t, func() {
		sayf("[mock-agent] a %d\n", 1)
		say("[mock-agent] b\n")
		sayErrf("[mock-agent] c %d\n", 2)
		sayErrln("[mock-agent] d")
	})
	if out != "[mock-agent] a 1\n[mock-agent] b\n" || errOut != "[mock-agent] c 2\n[mock-agent] d\n" {
		t.Errorf("unset: out %q err %q", out, errOut)
	}
	t.Setenv("MOCK_AGENT_QUIET", "1")
	out, errOut = captured(t, func() {
		sayf("[mock-agent] a %d\n", 1)
		say("[mock-agent] b\n")
		sayErrf("[mock-agent] c %d\n", 2)
		sayErrln("[mock-agent] d")
	})
	if out != "" || errOut != "" {
		t.Errorf("quiet: out %q err %q", out, errOut)
	}
}

// Every "[mock-agent]" line of the mock goes through the helpers (a new line that prints it directly would show an id on a quiet terminal): no source line may call fmt's printers with it.
func TestNoMockLineBypassesTheQuietHelpers(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		for i, l := range strings.Split(string(b), "\n") {
			tl := strings.TrimSpace(l)
			if strings.HasPrefix(tl, "//") || !strings.Contains(l, "[mock-agent]") {
				continue
			}
			if strings.Contains(l, "fmt.Print") || strings.Contains(l, "fmt.Fprint") {
				t.Errorf("%s:%d prints a [mock-agent] line without the quiet helpers: %s", f, i+1, tl)
			}
		}
	}
}

// startMock runs the test binary as the mock in ready mode with a pipe for a terminal, waits until its stdout holds want (or 6 seconds), then ends it and returns what it printed.
func startMock(t *testing.T, quiet bool, want string) string {
	t.Helper()
	cmd := exec.Command(os.Args[0], "--session-id", "00000000-0000-4000-8000-00000000c0de")
	cmd.Env = append(os.Environ(), "MOCK_AGENT_TEST_MAIN=1", "MOCK_AGENT_READY=1", "MOCK_AGENT_RAW_DIR="+t.TempDir(), "CLAUDE_PROJECTS_DIR="+t.TempDir(), "MOCK_AGENT_QUIET=")
	if quiet {
		cmd.Env = append(cmd.Env, "MOCK_AGENT_QUIET=1")
	}
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	got := make(chan string, 1)
	go func() {
		var all strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := out.Read(buf)
			all.Write(buf[:n])
			if strings.Contains(all.String(), want) || err != nil {
				got <- all.String()
				return
			}
		}
	}()
	var s string
	select {
	case s = <-got:
	case <-time.After(6 * time.Second):
		s = "(timed out)"
	}
	in.Close()
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return s + "\n--stderr--\n" + errBuf.String()
}

// QA Reviewer 2's SHOULD on #13180: the quiet raw-input start prints the banner line and none of the "[mock-agent]" lines; without the variable it prints the old ready line and no banner.
func TestQuietRawInputStartPrintsOnlyTheBanner(t *testing.T) {
	banner := strings.TrimSpace(quietBanner)
	q := startMock(t, true, banner)
	if !strings.Contains(q, banner) {
		t.Errorf("a quiet mock did not print the banner: %s", q)
	}
	if strings.Contains(q, "[mock-agent]") || strings.Contains(q, "session_id") || strings.Contains(q, "port=") {
		t.Errorf("a quiet mock printed one of its lines: %s", q)
	}
	loud := startMock(t, false, "raw input ready")
	if !strings.Contains(loud, "[mock-agent] raw input ready") || strings.Contains(loud, banner) {
		t.Errorf("an ordinary mock must print its ready line and no banner: %s", loud)
	}
}
