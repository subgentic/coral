//go:build !unix

package secrets

import "time"

// cpuTime: no process CPU time here (Windows); the guards time the wall clock as they always did.
func cpuTime() (time.Duration, bool) { return 0, false }
