//go:build windows

package executil

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"golang.org/x/sys/windows"
)

func stubOpen(t *testing.T, err error) {
	t.Helper()
	old := openForWait
	t.Cleanup(func() { openForWait = old })
	openForWait = func(uint32) (windows.Handle, error) { return 0, err }
}

// A process that cannot be opened for a reason other than "no such process" (access denied, say) is not known to be gone.
func TestExitedTakesOnlyNoSuchProcessAsGone(t *testing.T) {
	stubOpen(t, windows.ERROR_INVALID_PARAMETER)
	assert.True(t, exited(1234), "no process has this id: gone")
	stubOpen(t, windows.ERROR_ACCESS_DENIED)
	assert.False(t, exited(1234), "a live process Coral cannot open is not gone")
	stubOpen(t, errors.New("some other failure"))
	assert.False(t, exited(1234))
}

// The kill's error stays when the process cannot be opened and so is not known to be gone (after the bounded wait); with no such process it is the outcome that was wanted.
func TestKillRootKeepsItsErrorForAProcessItCannotOpenAndIsDoneForOneThatIsNotThere(t *testing.T) {
	oldW, oldG := rootExitWait, rootExitGap
	t.Cleanup(func() { rootExitWait, rootExitGap = oldW, oldG })
	rootExitWait, rootExitGap = 100*time.Millisecond, 10*time.Millisecond
	boom := errors.New("TerminateProcess: Access is denied.")

	stubOpen(t, windows.ERROR_ACCESS_DENIED)
	assert.Equal(t, boom, killRoot(killStub{boom}, 1234), "a live process that cannot be opened: the error stays")

	stubOpen(t, windows.ERROR_INVALID_PARAMETER)
	assert.ErrorIs(t, killRoot(killStub{boom}, 1234), os.ErrProcessDone, "no such process: done")
}
