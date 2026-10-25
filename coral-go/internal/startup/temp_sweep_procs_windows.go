//go:build windows

package startup

import (
	"context"
	"errors"
	"path/filepath"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/executil"
)

// windowsCommandLines is every running process's command line, one per line (#357): Windows PowerShell's Get-CimInstance over Win32_Process, run from the system folder by its full path (never
// found on PATH or in the current folder, and not built from the environment), with no window. The sweep needs it for its guard that no running process names a launch file's session; before, Windows had no list, and the
// sweep kept everything. A process with no command line (the system's own) prints an empty line. An error, or no output, makes the sweep keep every file, as before.
func windowsCommandLines(ctx context.Context) (string, error) {
	ps, err := systemPowerShell()
	if err != nil {
		return "", err
	}
	out, err := executil.Command(ctx, ps, "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }").Output()
	return string(out), err
}

// systemPowerShell is Windows PowerShell's full path under the system folder, which comes from the API and not from the environment: an unset SystemRoot must never make this a relative
// path that runs a planted program from the current folder (Security's note on #178). A path that is not absolute is refused.
func systemPowerShell() (string, error) {
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	ps := filepath.Join(dir, "WindowsPowerShell", "v1.0", "powershell.exe")
	if !filepath.IsAbs(ps) {
		return "", errors.New("the system folder is not an absolute path")
	}
	return ps, nil
}
