//go:build windows

package ptymanager

import (
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/tmux"
)

// resetStdinMemo empties the probes' memo (the tests' own entries).
func resetStdinMemo(t *testing.T) {
	t.Helper()
	stdinMemo.Lock()
	stdinMemo.m = map[stdinKey]*stdinEntry{}
	stdinMemo.workers = 0
	stdinMemo.Unlock()
}

// A probe that does not return is answered "reader" within the wait, its process gets no second worker, and at most stdinWorkersMax probes run at once: a full pool is a reader too.
// The caller never waits past its budget.
func TestAProbeThatDoesNotReturnNeverHoldsTheCaller(t *testing.T) {
	release := make(chan struct{})
	blocked := func(int) stdinKind { <-release; return stdinNotConsole }
	stdinProbeHook.Store(&blocked)
	resetStdinMemo(t)
	t.Cleanup(func() {
		stdinProbeHook.Store(nil)
		resetStdinMemo(t)
	})
	defer close(release)

	start := time.Now()
	assert.Equal(t, stdinUnreadable, classifyProcess(stdinKey{1, 1}, 100*time.Millisecond), "no answer in time: a reader")
	assert.Less(t, time.Since(start), time.Second)
	before := runtime.NumGoroutine()
	assert.Equal(t, stdinUnreadable, classifyProcess(stdinKey{1, 1}, 50*time.Millisecond))
	assert.Equal(t, before, runtime.NumGoroutine(), "the same process again: no second worker")

	for i := 2; i <= stdinWorkersMax; i++ {
		classifyProcess(stdinKey{i, 1}, time.Millisecond)
	}
	before = runtime.NumGoroutine()
	start = time.Now()
	assert.Equal(t, stdinUnreadable, classifyProcess(stdinKey{99, 1}, time.Second), "every worker busy: a reader, at once")
	assert.Less(t, time.Since(start), 100*time.Millisecond)
	assert.Equal(t, before, runtime.NumGoroutine(), "no worker beyond the cap")
}

func TestAnAnsweredProbeIsKeptForItsProcess(t *testing.T) {
	calls := 0
	counting := func(int) stdinKind { calls++; return stdinConsole }
	stdinProbeHook.Store(&counting)
	resetStdinMemo(t)
	t.Cleanup(func() {
		stdinProbeHook.Store(nil)
		resetStdinMemo(t)
	})
	assert.Equal(t, stdinConsole, classifyProcess(stdinKey{7, 70}, time.Second))
	assert.Equal(t, stdinConsole, classifyProcess(stdinKey{7, 70}, time.Second))
	assert.Equal(t, 1, calls, "one probe per process")
	classifyProcess(stdinKey{7, 71}, time.Second)
	assert.Equal(t, 2, calls, "a new process with the same pid is probed again")
}

// Live: a cmd waiting in ReadConsole below the recorded agent is refused within 2 s (its input is the console), a second check starts no new worker, and an agent beside it with
// nothing below is answered at once.
func TestAReaderBlockedInAReadIsRefusedQuicklyAndHoldsNoOneElse(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	resetStdinMemo(t)
	t.Cleanup(func() { resetStdinMemo(t) })
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	record := func(name string) {
		b.mu.RLock()
		p := b.sessions[name].proc.(*windowsPTY)
		b.mu.RUnlock()
		root := p.cpty.Pid()
		start, ok := processStart(root)
		require.True(t, ok)
		p.agent.mu.Lock()
		p.agent.proc, p.agent.adopted = winProc{pid: root, start: start, known: true}, true // the terminal's shell stands in for the agent: what is below it is what is checked
		p.agent.mu.Unlock()
	}
	stranger, plain := "claude-0425-reader", "claude-0425-plain"
	require.NoError(t, b.Spawn(stranger, "claude", t.TempDir(), "0425", "powershell.exe -NoProfile -Command cmd.exe /d /q", 120, 40))
	require.NoError(t, b.Spawn(plain, "claude", t.TempDir(), "0426", "powershell.exe -NoProfile", 120, 40))
	record(stranger)
	record(plain)
	require.Eventually(t, func() bool { _, why, _ := b.AgentTextRefused(stranger); return why == tmux.ReasonChildReads }, 20*time.Second, 200*time.Millisecond, "the cmd at its prompt reads the terminal")

	start := time.Now()
	refused, why, _ := b.AgentTextRefused(stranger)
	assert.True(t, refused)
	assert.Equal(t, tmux.ReasonChildReads, why)
	assert.Less(t, time.Since(start), 2*time.Second, "answered while the cmd is still waiting in its read")
	before := runtime.NumGoroutine()
	b.AgentTextRefused(stranger)
	assert.LessOrEqual(t, runtime.NumGoroutine(), before, "a second check starts no new worker")

	start = time.Now()
	refused, _, found := b.AgentTextRefused(plain)
	assert.True(t, found)
	assert.False(t, refused, "the agent beside it gets its text")
	assert.Less(t, time.Since(start), 2*time.Second)
}

// Only ERROR_INVALID_HANDLE from GetConsoleMode says a character device is not the console; any other answer is unreadable, a reader. A probe that panics is unreadable too.
func TestOnlyAnInvalidHandleAnswerSaysNotTheConsole(t *testing.T) {
	nul, err := os.Open(os.DevNull)
	require.NoError(t, err)
	defer nul.Close()
	h := windows.Handle(nul.Fd()) // a character device
	for name, tc := range map[string]struct {
		answer error
		want   stdinKind
	}{
		"taken: a console":     {nil, stdinConsole},
		"not a console handle": {windows.ERROR_INVALID_HANDLE, stdinNotConsole},
		"access denied":        {windows.ERROR_ACCESS_DENIED, stdinUnreadable},
		"any other answer":     {windows.ERROR_INVALID_FUNCTION, stdinUnreadable},
	} {
		t.Run(name, func(t *testing.T) {
			answer := func(windows.Handle) error { return tc.answer }
			consoleModeHook.Store(&answer)
			t.Cleanup(func() { consoleModeHook.Store(nil) })
			assert.Equal(t, tc.want, classifyStdin(h))
		})
	}
	assert.Equal(t, stdinNotConsole, classifyStdin(h), "the real NUL device answers ERROR_INVALID_HANDLE")

	panics := func(int) stdinKind { panic("a fault in the probe") }
	stdinProbeHook.Store(&panics)
	resetStdinMemo(t)
	t.Cleanup(func() {
		stdinProbeHook.Store(nil)
		resetStdinMemo(t)
	})
	assert.Equal(t, stdinUnreadable, classifyProcess(stdinKey{5, 5}, time.Second), "a probe that panics is a reader, and the process goes on")
}
