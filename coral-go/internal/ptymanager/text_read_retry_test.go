package ptymanager

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #470: a read of the terminal's processes that fails for a moment (a snapshot taken while programs start and end, the shell's handle refused for
// an instant) does not refuse the agent's text; only a read that fails every time does.
func TestAFailedProcessReadIsReadAgainBeforeTheTextIsRefused(t *testing.T) {
	const root = 10
	good := newFake().add(1, root, 100, kindVerifiedShell)
	noRoot := newFake() // a snapshot in which the shell could not be read

	sources := func(seq ...any) (func() (procSource, error), *int) {
		n := 0
		return func() (procSource, error) {
			i := n
			n++
			if i >= len(seq) {
				i = len(seq) - 1
			}
			switch v := seq[i].(type) {
			case error:
				return nil, v
			case *fakeProcs:
				return v, nil
			}
			return nil, errors.New("bad test")
		}, &n
	}
	failed := errors.New("snapshot failed")

	src, reads := sources(failed, failed, good)
	refused, why, err := textRefusedWithRetry(src, root, winProc{}, false)
	assert.NoError(t, err)
	assert.False(t, refused, "a snapshot that failed twice and then read: not refused (%s)", why)
	assert.Equal(t, 3, *reads)

	src, reads = sources(noRoot, good)
	refused, _, err = textRefusedWithRetry(src, root, winProc{}, false)
	assert.NoError(t, err)
	assert.False(t, refused, "the shell unreadable for one read, then read: not refused")
	assert.Equal(t, 2, *reads)

	src, reads = sources(failed)
	_, _, err = textRefusedWithRetry(src, root, winProc{}, false)
	assert.ErrorIs(t, err, failed, "every snapshot failed: the error stands (the backend refuses on it)")
	assert.Equal(t, textReadTries, *reads)

	src, reads = sources(noRoot)
	refused, why, err = textRefusedWithRetry(src, root, winProc{}, false)
	assert.NoError(t, err)
	assert.True(t, refused, "the shell unreadable in every read: refused")
	assert.Equal(t, reasonUnreadable, why)
	assert.Equal(t, textReadTries, *reads)

	cmd := newFake().add(1, root, 100, kindVerifiedShell)
	cmd.procs[root] = winProc{pid: root, start: 100, kind: kindVerifiedShell, known: true, name: "cmd"}
	src, reads = sources(cmd)
	refused, why, _ = textRefusedWithRetry(src, root, winProc{}, false)
	assert.True(t, refused)
	assert.Equal(t, reasonCmdShell, why, "an answer read from the processes stands at once")
	assert.Equal(t, 1, *reads)
}
