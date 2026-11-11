//go:build unix

package secrets

import (
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// cpuTime is the CPU time this process has used (user and system), so a pass is timed by the work it did and not by how long a loaded machine kept it waiting (#15536).
func cpuTime() (time.Duration, bool) {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}

// The linear guard times work, not waiting (#15536): a pass that is kept waiting for 150 ms (what a loaded machine does to any run) reads as the little CPU it used, and a pass that
// computes for that long still reads as that long.
func TestTheLinearGuardTimesCPUWorkNotWaiting(t *testing.T) {
	waits := func(string) { time.Sleep(150 * time.Millisecond) }
	assert.Less(t, bestOfThree(waits, ""), 30*time.Millisecond, "waiting is not work")
	burns := func(string) {
		c0, _ := cpuTime() // until 60 ms of CPU are used, however long a loaded machine takes to give them
		for c, _ := cpuTime(); c-c0 < 60*time.Millisecond; c, _ = cpuTime() {
		}
	}
	assert.Greater(t, bestOfThree(burns, ""), 50*time.Millisecond, "computing is")
}
