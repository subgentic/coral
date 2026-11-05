//go:build !windows

package resources

import "syscall"

// processAlive reports whether a process with this pid is running (signal 0 checks it exists and may be signalled: EPERM still means it exists).
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
