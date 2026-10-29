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
