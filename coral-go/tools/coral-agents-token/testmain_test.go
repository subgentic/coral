package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain runs the package's tests in a private temp and home folder (#356). This is a separate Go module, so it can't import
// the main module's internal/testtemp; it does the same for its own tests, without testtemp's Go-tool pinning (these tests run
// no go command).
func TestMain(m *testing.M) {
	os.Exit(runPrivate(m))
}

func runPrivate(m *testing.M) int {
	dir, err := os.MkdirTemp("", "cat-")
	if err != nil {
		return m.Run() // no private folder: the tests run as before
	}
	defer os.RemoveAll(dir)
	tmp, home := filepath.Join(dir, "tmp"), filepath.Join(dir, "home")
	for _, d := range []string{tmp, home} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return m.Run()
		}
	}
	for k, v := range map[string]string{"TMPDIR": tmp, "TMP": tmp, "TEMP": tmp, "HOME": home, "USERPROFILE": home} {
		os.Setenv(k, v)
	}
	return m.Run()
}
