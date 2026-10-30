// Package consoletest keeps Windows tests from opening console windows on the person's desktop (#381, #382). A console program (cmd, powershell, git, icacls, ping) started
// from a test binary that has no console of its own gets a new console, which Windows hands to the default terminal (OpenConsole.exe -Embedding, under svchost) and shows.
// HiddenCommand starts one with CREATE_NO_WINDOW; Guard fails a package's test run if a console host the default terminal started appears during it; the lint (lint_test.go)
// fails on a direct exec.Command in the Windows test files of the packages it lists.
package consoletest

import (
	"os/exec"
	"testing"

	"github.com/subgentic/coral/internal/executil"
)

// HiddenCommand is exec.Command for a console program a test starts directly (not in a pseudo console), with no window on Windows. Elsewhere it is exec.Command.
func HiddenCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	executil.HideWindow(cmd)
	return cmd
}

// Guard runs a package's tests (m.Run) and fails the run, naming them, if a console host the default terminal started appeared during it. Use it from TestMain:
// os.Exit(consoletest.Guard(m)). The tripwire is per test binary, not per test: a console host the default terminal starts for something else on the machine during the
// run also fails it, and the message says so. Only hosts whose parent is svchost.exe count, so the pseudo-console hosts the PTY tests start on purpose do not.
func Guard(m *testing.M) int {
	check := startTripwire()
	code := m.Run()
	if extra := check(); len(extra) > 0 {
		printTripwire(extra)
		if code == 0 {
			code = 1
		}
	}
	return code
}
