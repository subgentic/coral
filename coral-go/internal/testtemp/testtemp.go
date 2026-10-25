// Package testtemp gives a test package a private world: its TestMain calls Use (or Run), and the package's tests find one new folder where the system temp folder, the home folder and
// Coral's data folder would be. It is removed when the package's tests end (#354).
//
// Temp: Go's t.TempDir opens the temp folder itself, and `go test` re-lists every directory a cached test opened each time it checks the cache. With a person's real %TEMP% holding
// hundreds of thousands of entries (Codex launch files that tests left there before they had private folders), every cached package that called t.TempDir paid for that listing: a warm
// `go test ./...` of nothing to run took 908 s. In a private folder the listing is the package's own.
//
// Home and data folder: no test may touch the person's real ~/.coral or home (a package's tests stat it thousands of times, and a test that wrote there would write the person's data), so
// HOME, USERPROFILE and CORAL_DATA_DIR point into the folder as well. The Go tool keeps what it needs from the real home: its build cache, GOPATH, module cache and settings file are fixed to where `go env` says they are (a person's `go env -w` included), so a test that runs `go build` or `go list` does not start a cold cache.
package testtemp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Use points TMPDIR, TMP, TEMP, HOME, USERPROFILE and CORAL_DATA_DIR at a new folder for the rest of the process and returns the func that removes it. A test that sets one of them
// itself (t.Setenv) still can. If the folder can't be made it changes nothing.
//
// It acts only in the process `go test` started (or a runner that passes the same flag, tools/go_test_shard.py): a test that re-runs its own binary as a helper child (51 test files do:
// coral-board's runBoardInput, the fake CLIs, the hook echoes) hands that child exactly the environment it means it to have, and the child's own TestMain must not replace it. `go test`
// always gives the test binary -test.paniconexit0; a helper child started with just -test.run=... does not (QA, #177).
func Use() (cleanup func()) {
	if !startedByGoTest(os.Args) || os.Getenv(Marker) != "" {
		return func() {}
	}
	return setup()
}

// Marker is set (to the private folder) by the process that made the private world. A child that inherits it, whatever its arguments, changes nothing. Its name starts with none of the
// prefixes a helper strips from the environment it hands its child (CORAL_, TMUX, HOME).
const Marker = "TESTTEMP_ACTIVE"

// startedByGoTest reports whether args are those `go test` gives a test binary (it always adds -test.paniconexit0).
func startedByGoTest(args []string) bool {
	for _, a := range args {
		switch a {
		case "-test.paniconexit0", "-test.paniconexit0=true", "-test.paniconexit0=1", "--test.paniconexit0":
			return true
		}
	}
	return false
}

func setup() (cleanup func()) {
	pinGoTool()
	dir, err := os.MkdirTemp("", "ct-")
	if err != nil {
		return func() {}
	}
	tmp, home, data := filepath.Join(dir, "tmp"), filepath.Join(dir, "home"), filepath.Join(dir, "coral-data")
	for _, d := range []string{tmp, home, data} {
		if os.MkdirAll(d, 0o700) != nil {
			os.RemoveAll(dir)
			return func() {}
		}
	}
	release := hold(dir, tmp, home, data) // closed first in cleanup
	os.Setenv(Marker, dir)
	for k, v := range map[string]string{"TMPDIR": tmp, "TMP": tmp, "TEMP": tmp, "HOME": home, "USERPROFILE": home, "CORAL_DATA_DIR": data} {
		os.Setenv(k, v)
	}
	return func() { os.Unsetenv(Marker); release(); os.RemoveAll(dir) }
}

// Run is a TestMain body: the package's tests in a private world, whose exit code it returns (os.Exit(testtemp.Run(m))).
func Run(m *testing.M) int {
	cleanup := Use()
	code := m.Run()
	cleanup()
	return code
}

// Exit removes the private folder and exits with code: for a TestMain that has its own checks to run after the tests (os.Exit(testleak.Check(code)) becomes testtemp.Exit(cleanup, testleak.Check(code))).
func Exit(cleanup func(), code int) {
	cleanup()
	os.Exit(code)
}

// pinGoTool fixes where the Go tool keeps its build cache, GOPATH, module cache and settings file to where they are now, before HOME moves: it asks `go env`, which knows the person's
// `go env -w` settings, so a test that runs `go build` or `go list` uses the same warm cache and modules. Where `go` can't be asked, the defaults a plain install has are pinned.
func pinGoTool() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "go", "env", "GOCACHE", "GOPATH", "GOMODCACHE", "GOENV").Output(); err == nil {
		lines := strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n")
		if len(lines) >= 4 {
			for i, k := range []string{"GOCACHE", "GOPATH", "GOMODCACHE", "GOENV"} {
				if v := strings.TrimSpace(lines[i]); v != "" {
					os.Setenv(k, v)
				}
			}
			return
		}
	}
	if os.Getenv("GOCACHE") == "" {
		if d, err := os.UserCacheDir(); err == nil {
			os.Setenv("GOCACHE", filepath.Join(d, "go-build"))
		}
	}
	if home, err := os.UserHomeDir(); err == nil && os.Getenv("GOPATH") == "" {
		os.Setenv("GOPATH", filepath.Join(home, "go"))
	}
	if os.Getenv("GOENV") == "" {
		if d, err := os.UserConfigDir(); err == nil {
			os.Setenv("GOENV", filepath.Join(d, "go", "env"))
		}
	}
}
