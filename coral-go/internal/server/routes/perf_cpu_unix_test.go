//go:build !windows

package routes

import (
	"syscall"
	"time"
)

// processCPU is the CPU time (user and system) this test process has used so far, and whether the platform says (#16035).
func processCPU() (time.Duration, bool) {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}
