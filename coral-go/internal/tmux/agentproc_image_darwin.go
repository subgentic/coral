//go:build darwin

package tmux

import (
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// ProgramImage is the path of the program a process runs: ps reports it as the command on macOS. "" when it cannot be read.
func ProgramImage(pid int) string {
	out, err := executil.Output(5*time.Second, "ps", "-o", "comm=", "-p", strconv.Itoa(pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
