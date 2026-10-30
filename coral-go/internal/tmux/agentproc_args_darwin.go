//go:build darwin

package tmux

import (
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// ProgramArgs is a process's arguments as ps prints them: ONE space-joined line, so it is split on blanks and an argument with a space in it is split wrongly. That is safe for its one use
// (the script path is compared with the CLI's real path, and a half of a path is not it, so the answer is "needs the button"). Compared and dropped; never logged or kept. nil when unreadable.
func ProgramArgs(pid int) []string {
	out, err := executil.Output(5*time.Second, "ps", "-o", "args=", "-p", strconv.Itoa(pid))
	if err != nil || len(out) > 64*1024 {
		return nil
	}
	return strings.Fields(string(out))
}

// ProgramCwd is a process's working directory, from lsof (macOS has no /proc), "" when it cannot be read. Used to make a relative script argument (`./stub.sh`) absolute.
func ProgramCwd(pid int) string {
	out, err := executil.Output(5*time.Second, "lsof", "-a", "-d", "cwd", "-Fn", "-p", strconv.Itoa(pid))
	if err != nil || len(out) > 64*1024 {
		return ""
	}
	dir, count := "", 0
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			dir, count = strings.TrimSpace(line[1:]), count+1
		}
	}
	if count != 1 {
		return "" // not exactly one name field: no answer, so no match
	}
	return dir
}
