package consoletest

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

var stub struct {
	sync.Mutex
	path string
	err  error
	done bool
}

// StubProgram is a small program of its own that exits 0 at once, whatever arguments it gets: the stand-in for an agent CLI that a test names (as the target of a
// stand-in npm .cmd). It is never the test binary: a CLI check or a version probe that starts it would run the whole test suite again, which probes again. It is built
// once per test process, with the Go toolchain that runs the tests, in a folder of the process's temp folder.
func StubProgram(t testing.TB) string {
	t.Helper()
	stub.Lock()
	defer stub.Unlock()
	if !stub.done {
		stub.done = true
		stub.path, stub.err = buildStubProgram()
	}
	if stub.err != nil {
		t.Fatalf("build the stand-in CLI program: %v", stub.err)
	}
	return stub.path
}

func buildStubProgram() (string, error) {
	dir, err := os.MkdirTemp("", "coral-stub-cli-")
	if err != nil {
		return "", err
	}
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte("package main\n\nfunc main() {}\n"), 0o600); err != nil {
		return "", err
	}
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goBin += ".exe"
	}
	out := filepath.Join(dir, "stubcli.exe")
	cmd := HiddenCommand(goBin, "build", "-o", out, src)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOFLAGS=", "GO111MODULE=off", "GOWORK=off")
	if b, err := cmd.CombinedOutput(); err != nil {
		return "", &stubBuildError{err: err, output: string(b)}
	}
	return out, nil
}

type stubBuildError struct {
	err    error
	output string
}

func (e *stubBuildError) Error() string { return e.err.Error() + ": " + e.output }
