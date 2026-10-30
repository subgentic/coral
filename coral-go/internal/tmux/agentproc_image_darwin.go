//go:build darwin

package tmux

import (
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// ProgramImage is the path of the program a process runs: ps reports it as the command on macOS. "" when it cannot be read.
//
// macOS CAVEAT: this is NOT the kernel's image. ps's comm (and args) follow argv[0], which a process sets as it likes (`exec -a node ...`), so on macOS the "image" is a convenience that
// catches an accident, not a check that holds against a program built to look like the agent. Linux reads /proc/<pid>/exe, which the process cannot rewrite. The proper source on macOS is
// proc_pidpath (libproc, needs cgo); until it is used, the interpreter rule for the bulk record (ptymanager.ScriptIsCLI) and the program name shown to the Operator are convenience there.
func ProgramImage(pid int) string {
	out, err := executil.Output(5*time.Second, "ps", "-o", "comm=", "-p", strconv.Itoa(pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
