package testtemp

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

const (
	inDirEnv  = "TESTTEMP_INDIR"
	inDirTest = "TESTTEMP_INDIR_TEST"
)

// InDir runs body with a new folder as the working directory, in a child run of this test binary, and returns what it did to t.
//
// Why not t.Chdir(t.TempDir()): the Go tool's test cache records every os.Chdir with the absolute path it went to and re-stats that path to decide whether a cached result still holds. A path made
// for one run is gone or new at the next, so a package with one such test is never served from the cache (#413). The child is started with Dir set to the folder, so this process never
// changes directory and logs nothing the cache would compare. The child runs only this test (-test.run=^Name$), and body gets the folder it is running in.
//
// The child inherits the environment, so it keeps the private world the parent's TestMain made. A child's failure, or a skip, is the parent's. body must not depend on other tests having run.
func InDir(t *testing.T, body func(t *testing.T, dir string)) {
	t.Helper()
	if dir := os.Getenv(inDirEnv); dir != "" && os.Getenv(inDirTest) == t.Name() {
		body(t, dir)
		return
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.count=1", "-test.v")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), inDirEnv+"="+dir, inDirTest+"="+t.Name())
	out, err := cmd.CombinedOutput()
	text := string(out)
	switch {
	case err != nil:
		t.Fatalf("%s failed in its own folder:\n%s", t.Name(), text)
	case strings.Contains(text, "--- SKIP: "+t.Name()):
		t.Skipf("skipped in the child run:\n%s", text)
	case !strings.Contains(text, "--- PASS: "+t.Name()):
		t.Fatalf("the child run did not run %s:\n%s", t.Name(), text)
	}
}
