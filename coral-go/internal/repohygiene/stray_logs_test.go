// Package repohygiene holds checks about what is committed to the repository, not about what the code does.
package repohygiene

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A test run's own output (a log, a ".done" marker) must never be committed: three of them reached main in a release's tree once, written by a replay's "git add -A" (c72059bb9), and one held a bidi
// character testguard flags. The scratch names are ignored in .gitignore, and this fails on any committed *.log or *.done that is not a fixture (under a testdata or fixtures folder, or one a test pins).
// It needs git and a checkout; in a source archive without either it is skipped.
func TestNoStrayLogsAreCommitted(t *testing.T) {
	root, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not a git checkout (or no git): nothing to check")
	}
	top := strings.TrimSpace(string(root))
	cmd := exec.Command("git", "ls-files", "-z", "--", "*.log", "*.done")
	cmd.Dir = top
	out, err := cmd.Output()
	if err != nil {
		t.Skip("git ls-files failed: " + err.Error())
	}
	var stray []string
	for _, f := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		if f == "" || isFixture(f) {
			continue
		}
		stray = append(stray, f)
	}
	if len(stray) > 0 {
		t.Errorf("committed scratch output (remove it with git rm; a fixture belongs under testdata/ or fixtures/): %s", strings.Join(stray, ", "))
	}
}

// isFixture reports whether a committed log is a fixture: a folder named testdata, fixtures or golden anywhere in its path (vendored third-party trees keep their own).
func isFixture(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		switch part {
		case "testdata", "fixtures", "golden", "vendor", "node_modules":
			return true
		}
	}
	return false
}

func TestIsFixture(t *testing.T) {
	for p, want := range map[string]bool{
		"go-206.log": false, "gotest-full.log": false, "coral-go/gotest-final.log": false, "browser-adds.log": false, "x.done": false, "tools/run.log": false,
		"coral-go/internal/foo/testdata/a.log": true, "tests/frontend/fixtures/b.log": true, "coral-go/pkg/frontend/static/vendor/x/c.log": true,
	} {
		if got := isFixture(p); got != want {
			t.Errorf("isFixture(%q) = %v, want %v", p, got, want)
		}
	}
}
