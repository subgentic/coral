//go:build !unix

package machinelaunch

import (
	"fmt"
	"os"
	"time"
)

// lockFile takes the lock where there is no flock: a lock file made with O_EXCL, retried for ten seconds. One left behind by a process that died (older than thirty seconds) is taken over.
func lockFile(path string) (func(), error) {
	deadline := time.Now().Add(10 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if fi, serr := os.Stat(path); serr == nil && time.Since(fi.ModTime()) > 30*time.Second {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("could not lock the state file: %s is held by another launch", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
