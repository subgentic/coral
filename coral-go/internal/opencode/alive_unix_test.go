//go:build !windows

package opencode

import "syscall"

// testProcessAlive says whether a process with this pid still exists.
func testProcessAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }
