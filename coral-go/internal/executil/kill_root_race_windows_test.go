//go:build windows

package executil

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

type killStub struct{ err error }

func (k killStub) Kill() error { return k.err }

// A shim that is ending by itself answers "access denied" to the kill before its handle is signalled: that is the process being gone a few milliseconds later, not a failure.
func TestKillRootWaitsForAProcessThatIsEndingByItself(t *testing.T) {
	old := processExited
	t.Cleanup(func() { processExited = old })
	calls := 0
	processExited = func(uint32) bool { calls++; return calls > 5 }
	err := killRoot(killStub{errors.New("TerminateProcess: Access is denied.")}, 1234)
	assert.ErrorIs(t, err, os.ErrProcessDone, "the process was gone after a few reads")
	assert.Greater(t, calls, 5)
}

// A process that is still running after the wait keeps the error, and the wait is bounded.
func TestKillRootKeepsTheErrorOfAProcessThatStaysAlive(t *testing.T) {
	oldE, oldW, oldG := processExited, rootExitWait, rootExitGap
	t.Cleanup(func() { processExited, rootExitWait, rootExitGap = oldE, oldW, oldG })
	processExited = func(uint32) bool { return false }
	rootExitWait, rootExitGap = 200*time.Millisecond, 10*time.Millisecond
	boom := errors.New("TerminateProcess: Access is denied.")
	start := time.Now()
	assert.Equal(t, boom, killRoot(killStub{boom}, 1234))
	assert.Less(t, time.Since(start), 2*time.Second)
	assert.GreaterOrEqual(t, time.Since(start), 150*time.Millisecond)
}

func TestKillRootWithNoErrorIsNoWait(t *testing.T) {
	assert.NoError(t, killRoot(killStub{nil}, 1234))
}
