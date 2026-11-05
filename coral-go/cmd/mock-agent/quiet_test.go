package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
