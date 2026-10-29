package ptymanager

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// #381: this package's Windows tests start console programs only through hiddenCommand (or inside a pseudo console), so none opens a
// console window on the person's desktop. A new exec.Command in a Windows test file fails here.
func TestWindowsTestsStartConsoleProgramsHidden(t *testing.T) {
	files, err := filepath.Glob("*_windows_test.go")
	if err != nil {
		t.Fatal(err)
	}
	direct := regexp.MustCompile(`\bexec\.Command(Context)?\(`)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for n, line := range strings.Split(string(b), "\n") {
			code := strings.TrimSpace(line)
			if strings.HasPrefix(code, "//") || f == "console_windows_test.go" && strings.Contains(code, "cmd := exec.Command(name, args...)") {
				continue
			}
			if direct.MatchString(code) {
				t.Errorf("%s:%d starts a program with exec.Command: use hiddenCommand, so no console window opens (#381): %s", f, n+1, code)
			}
		}
	}
}
