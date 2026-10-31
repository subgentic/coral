//go:build windows

package opencode

import "golang.org/x/sys/windows"

// testProcessAlive says whether a process with this pid exists and has not ended (the exit code of a running one is STILL_ACTIVE, 259).
func testProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259
}
