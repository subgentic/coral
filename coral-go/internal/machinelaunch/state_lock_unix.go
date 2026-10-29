//go:build unix

package machinelaunch

import (
	"fmt"
	"os"
	"syscall"
)

// lockFile takes an exclusive advisory lock (flock) on path, waiting for it, and returns what releases it. The lock is on the open file, so a process that dies releases it with its descriptors.
func lockFile(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("could not open the state file's lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("could not lock the state file: %w", err)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
