//go:build !windows

package loginpath

import (
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
)

// Off is the environment variable that turns the widening off.
const Off = "CORAL_NO_LOGIN_PATH"

// timeout is how long the shell has: a profile that waits for a prompt, a network mount or a password is given up on.
const timeout = 5 * time.Second

// stdinIsTerminal is a variable so a test can stand in for a Coral started from a shell.
var stdinIsTerminal = func() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

// Widen appends to this process's PATH the folders its user's login shell has and it has not, unless Coral was started from a terminal (its PATH is then the shell's own) or CORAL_NO_LOGIN_PATH is set.
// It never fails a start: a shell that is missing, slow or prints nothing leaves the PATH as it was, with a line in the log. It returns how many folders were added.
func Widen() int {
	if os.Getenv(Off) != "" || stdinIsTerminal() {
		return 0
	}
	login, err := ask(shellsToTry())
	if err != nil {
		log.Printf("[startup] the login shell's PATH was not read: %v", err)
		return 0
	}
	merged, added := Merge(os.Getenv("PATH"), login, string(os.PathListSeparator))
	if added > 0 {
		_ = os.Setenv("PATH", merged)
		log.Printf("[startup] this Coral was not started from a shell: %d folder(s) of the login shell's PATH were added to its own", added)
	}
	return added
}

// shellsToTry is the user's shell, then the system's: only a file that exists and runs (a variable so a test names its own).
var shellsToTry = func() []string {
	var out []string
	if s := strings.TrimSpace(os.Getenv("SHELL")); s != "" && filepath.IsAbs(s) {
		out = append(out, s)
	}
	return append(out, "/bin/zsh", "/bin/bash")
}

// ask runs the first shell that answers as an interactive login shell (a PATH exported in .zshrc, as nvm's is, counts as much as one in .zprofile) with no input, and returns the PATH it printed.
func ask(shells []string) (string, error) {
	var lastErr error
	seen := map[string]bool{}
	for _, sh := range shells {
		if seen[sh] {
			continue
		}
		seen[sh] = true
		if st, err := os.Stat(sh); err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
			continue
		}
		p, err := run(sh)
		if err == nil && p != "" {
			return p, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errNoShell
	}
	return "", lastErr
}

var errNoShell = &shellError{"no login shell answered"}

type shellError struct{ s string }

func (e *shellError) Error() string { return e.s }

func run(shell string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '%s%s%s' '`+beginMark+`' "$PATH" '`+endMark+`'`)
	cmd.Stdin = nil // /dev/null
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}                                // an interactive shell asks for a terminal's foreground: in a group of its own it never takes this process's
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) } // the group it was started in: a profile's children go with it
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil && out.Len() == 0 {
		return "", err
	}
	return parse(out.String()), nil
}
