package ptymanager

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/tmux"
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

// The "a program below the agent reads the terminal" refusal stands only if a fresh read agrees (Security's #6911 point 5): a reader seen once and
// gone in the re-read does not refuse; one seen in both does; a re-read that fails keeps the refusal; and a clean first read stands at once.
func TestAChildReaderRefusesOnlyWhenTheFreshReadAgrees(t *testing.T) {
	const root, agent, child = 10, 20, 30
	rec := winProc{pid: agent, start: 200, known: true}
	clean := func() *fakeProcs { return newFake().add(1, root, 100, kindVerifiedShell).add(root, agent, 200, 0) }
	reading := func() *fakeProcs {
		f := clean().add(agent, child, 300, 0)
		f.procs[child] = winProc{pid: child, start: 300, known: true, name: "node"}
		return f.withStdin(child, stdinConsole)
	}
	seq := func(steps ...any) (func() (procSource, error), *int) {
		n := 0
		return func() (procSource, error) {
			i := n
			n++
			if i >= len(steps) {
				i = len(steps) - 1
			}
			if err, ok := steps[i].(error); ok {
				return nil, err
			}
			return steps[i].(*fakeProcs), nil
		}, &n
	}

	src, reads := seq(reading(), clean())
	refused, why, err := textRefusedWithRetry(src, root, rec, true)
	assert.NoError(t, err)
	assert.False(t, refused, "a reader in the first read and gone in the fresh one does not refuse (%s)", why)
	assert.Equal(t, 2, *reads, "the refusal was read again")

	src, reads = seq(reading(), reading())
	refused, why, _ = textRefusedWithRetry(src, root, rec, true)
	assert.True(t, refused, "a reader in both reads refuses")
	assert.Equal(t, tmux.ReasonChildReads, why)
	assert.Equal(t, 2, *reads)

	src, reads = seq(reading(), errors.New("snapshot failed"))
	refused, why, _ = textRefusedWithRetry(src, root, rec, true)
	assert.True(t, refused, "a re-read that fails keeps the refusal")
	assert.Equal(t, tmux.ReasonChildReads, why)
	assert.Equal(t, 2, *reads)

	src, reads = seq(clean(), reading())
	refused, _, _ = textRefusedWithRetry(src, root, rec, true)
	assert.False(t, refused, "a clean first read stands: no second read is asked for")
	assert.Equal(t, 1, *reads)
}

// trial-250's windows-tests (fourth head): TestShortLivedChildrenOfTheAgentNeverRefuseIt got "the terminal's processes could not be read" once in 100 sends while hooks started and ended below the
// agent, on a loaded runner: the shell's handle was refused for longer than three reads 10 ms apart. A stall of four reads is still a stall, not "unreadable": more reads, further apart.
func TestTheShellUnreadableForAFewReadsInARowIsStillReadAgain(t *testing.T) {
	const root = 10
	good := newFake().add(1, root, 100, kindVerifiedShell)
	noRoot := newFake()
	reads := 0
	src := func() (procSource, error) {
		reads++
		if reads <= 4 {
			return noRoot, nil
		}
		return good, nil
	}
	refused, why, err := textRefusedWithRetry(src, root, winProc{}, false)
	assert.NoError(t, err)
	assert.False(t, refused, "the shell unreadable for four reads, then read: not refused (%s)", why)
	assert.Equal(t, 5, reads)
}
