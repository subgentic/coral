//go:build windows

package agent

import (
	"os"
	"os/exec"
	"path/filepath"

	"github.com/subgentic/coral/internal/consoletest"
)

// cmdExe runs a hook command line through cmd.exe exactly as written (Go's own argument
// quoting would escape its quotes in a way cmd.exe doesn't read).
func cmdExe(line string) *exec.Cmd {
	c := consoletest.HiddenCommand(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"))
	c.SysProcAttr.CmdLine = `cmd.exe /d /s /c "` + line + `"` // HiddenCommand made SysProcAttr (CREATE_NO_WINDOW)
	return c
}
