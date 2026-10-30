//go:build windows

package config

import "golang.org/x/sys/windows"

// stillActive is the exit code GetExitCodeProcess reports for a process that has not ended.
const stillActive = 259

// processAlive says whether a process with this PID exists and has not ended.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false // no such process, or one this user may not look at: not a server of this user's
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}
