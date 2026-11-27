//go:build !windows

package resources

import (
	"os"
	"syscall"
)

// processAlive says whether pid is a live process on this computer (#21800). An unknown answer is alive: a run is dropped only when it is surely gone.
func processAlive(pid int) bool {
	if pid <= 1 {
		return true
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || err != syscall.ESRCH
}
