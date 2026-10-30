//go:build !windows

package config

import (
	"errors"
	"syscall"
)

// processAlive says whether a process with this PID exists (it may belong to another user: that still counts).
func processAlive(pid int) bool {
	if pid <= 1 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
