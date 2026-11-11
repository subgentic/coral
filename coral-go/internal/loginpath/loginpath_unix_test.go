//go:build !windows

package loginpath

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeShell writes an executable script that stands for the user's shell: body runs whatever the arguments are (-ilc and the command), as a real shell's startup files would.
func fakeShell(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sh")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	return p
}

func withPath(t *testing.T, path string) {
	t.Helper()
	old, had := os.LookupEnv("PATH")
	require.NoError(t, os.Setenv("PATH", path))
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("PATH", old)
		} else {
			_ = os.Unsetenv("PATH")
		}
	})
}

// useShell makes sh the only shell asked, so a test never reads the real user's.
func useShell(t *testing.T, sh string) {
	t.Helper()
	old := shellsToTry
	shellsToTry = func() []string { return []string{sh} }
	t.Cleanup(func() { shellsToTry = old })
}

// onMac makes Widen run as it does on macOS, the one system it widens on.
func onMac(t *testing.T, goosName string) {
	t.Helper()
	old := goos
	goos = goosName
	t.Cleanup(func() { goos = old })
}

func notFromTerminal(t *testing.T, tty bool) {
	t.Helper()
	onMac(t, "darwin")
	old := stdinIsTerminal
	stdinIsTerminal = func() bool { return tty }
	t.Cleanup(func() { stdinIsTerminal = old })
}

// A Finder-launched Coral: the bare PATH gets the folders the user's shell has, behind it, and the profile's chatter does not matter.
func TestACoralNotStartedFromAShellGetsItsLoginShellsFolders(t *testing.T) {
	sh := fakeShell(t, `echo "Last login: today"; printf '%s' '`+beginMark+`/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`+endMark+`'; echo goodbye`)
	useShell(t, sh)
	t.Setenv(Off, "")
	notFromTerminal(t, false)
	withPath(t, "/usr/bin:/bin:/usr/sbin:/sbin")
	assert.Equal(t, 2, Widen())
	assert.Equal(t, "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/opt/homebrew/bin", os.Getenv("PATH"))
}

func TestACoralStartedFromATerminalOrSwitchedOffKeepsItsPath(t *testing.T) {
	sh := fakeShell(t, `printf '%s' '`+beginMark+`/extra/bin`+endMark+`'`)
	useShell(t, sh)
	withPath(t, "/usr/bin")

	t.Setenv(Off, "")
	notFromTerminal(t, true)
	assert.Zero(t, Widen(), "started from a shell: its PATH is the shell's own")
	assert.Equal(t, "/usr/bin", os.Getenv("PATH"))

	notFromTerminal(t, false)
	t.Setenv(Off, "1")
	assert.Zero(t, Widen(), "switched off")
	assert.Equal(t, "/usr/bin", os.Getenv("PATH"))
}

// A profile that never ends is given up on after the timeout, the start goes on with the PATH it has, and the shell and what it started are gone.
func TestAShellThatNeverAnswersIsGivenUpOn(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child-pid")
	sh := fakeShell(t, `/bin/sleep 60 & echo $! > `+marker+`; wait`)
	useShell(t, sh)
	t.Setenv(Off, "")
	notFromTerminal(t, false)
	withPath(t, "/usr/bin")
	start := time.Now()
	assert.Zero(t, Widen())
	assert.Less(t, time.Since(start), timeout+3*time.Second)
	assert.Equal(t, "/usr/bin", os.Getenv("PATH"))
	pid, err := os.ReadFile(marker)
	require.NoError(t, err)
	n, err := strconv.Atoi(strings.TrimSpace(string(pid)))
	require.NoError(t, err)
	assert.Eventually(t, func() bool { return syscall.Kill(n, 0) == syscall.ESRCH }, 3*time.Second, 50*time.Millisecond, "what the profile started was ended with it")
}

func TestAShellThatPrintsNothingUsableLeavesThePathAlone(t *testing.T) {
	useShell(t, fakeShell(t, `echo "just noise"`))
	t.Setenv(Off, "")
	notFromTerminal(t, false)
	withPath(t, "/usr/bin")
	assert.Zero(t, Widen())
	assert.Equal(t, "/usr/bin", os.Getenv("PATH"))
}

// A Linux or devserver service keeps the PATH it was given: nothing is asked of any shell, whatever it would print.
func TestACoralOnLinuxKeepsThePathItWasGiven(t *testing.T) {
	useShell(t, fakeShell(t, `printf '%s' '`+beginMark+`/extra/bin`+endMark+`'`))
	t.Setenv(Off, "")
	notFromTerminal(t, false)
	onMac(t, "linux")
	withPath(t, "/usr/bin")
	assert.Zero(t, Widen())
	assert.Equal(t, "/usr/bin", os.Getenv("PATH"))
	onMac(t, "darwin")
	assert.Equal(t, 1, Widen(), "the same shell on macOS is asked: the test sees the difference")
	assert.Equal(t, "/usr/bin:/extra/bin", os.Getenv("PATH"))
}
