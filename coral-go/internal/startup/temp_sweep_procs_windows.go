//go:build windows

package startup

import (
	"context"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/executil"
)

// windowsCommandLines is every running process's command line, one per line (#357): Windows PowerShell's Get-CimInstance over Win32_Process, run from System32 by its full path (never
// found on PATH or in the current folder), with no window. The sweep needs it for its guard that no running process names a launch file's session; before, Windows had no list, and the
// sweep kept everything. A process with no command line (the system's own) prints an empty line. An error, or no output, makes the sweep keep every file, as before.
func windowsCommandLines(ctx context.Context) (string, error) {
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	out, err := executil.Command(ctx, ps, "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }").Output()
	return string(out), err
}
