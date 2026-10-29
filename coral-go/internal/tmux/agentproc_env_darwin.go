//go:build darwin

package tmux

import (
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// procEnvHasSession: 'ps eww' shows the environment of the user's own processes after the command. False when it cannot be read.
func procEnvHasSession(pid int, session string) bool {
	out, err := executil.Output(5*time.Second, "ps", "eww", "-o", "command=", "-p", strconv.Itoa(pid))
	if err != nil {
		return false
	}
	want := "CORAL_SESSION_NAME=" + session
	line := " " + strings.TrimSpace(string(out)) + " "
	return strings.Contains(line, " "+want+" ")
}
