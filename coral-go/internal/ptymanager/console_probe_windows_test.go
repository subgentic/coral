//go:build windows

package ptymanager

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/consoletest"
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
	assert.Equal(t, stdinUnreadable, classifyKind(stdinKey{1, 1}, 100*time.Millisecond), "no answer in time: a reader")
	assert.Less(t, time.Since(start), time.Second)
	before := runtime.NumGoroutine()
	assert.Equal(t, stdinUnreadable, classifyKind(stdinKey{1, 1}, 50*time.Millisecond))
	assert.Equal(t, before, runtime.NumGoroutine(), "the same process again: no second worker")

	for i := 2; i <= stdinWorkersMax; i++ {
		classifyKind(stdinKey{i, 1}, time.Millisecond)
	}
	before = runtime.NumGoroutine()
	start = time.Now()
	assert.Equal(t, stdinUnreadable, classifyKind(stdinKey{99, 1}, time.Second), "every worker busy: a reader, at once")
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
	assert.Equal(t, stdinConsole, classifyKind(stdinKey{7, 70}, time.Second))
	assert.Equal(t, stdinConsole, classifyKind(stdinKey{7, 70}, time.Second))
	assert.Equal(t, 1, calls, "one probe per process")
	classifyKind(stdinKey{7, 71}, time.Second)
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
	assert.Equal(t, stdinUnreadable, classifyKind(stdinKey{5, 5}, time.Second), "a probe that panics is a reader, and the process goes on")
}

// processGone: a process that is there is not gone; one that has exited is; one whose creation time is not the one the walk saw (a reused pid) is.
func TestAProcessIsGoneWhenItEndedOrItsPidNamesAnother(t *testing.T) {
	me := os.Getpid()
	start, ok := processStart(me)
	require.True(t, ok)
	assert.False(t, processGone(me, start))
	assert.False(t, processGone(me, 0))
	assert.True(t, processGone(me, start+1), "another creation time: not the process the walk saw")

	cmd := consoletest.HiddenCommand("cmd.exe", "/c", "exit 0")
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	require.NoError(t, cmd.Wait())
	assert.True(t, processGone(pid, 0), "it has ended")
}

// Live (QA's #6908): an agent whose children start and end all the time (hooks with a pipe as their input) is never refused for them.
func TestShortLivedChildrenOfTheAgentNeverRefuseIt(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	resetStdinMemo(t)
	t.Cleanup(func() { resetStdinMemo(t) })
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-0425-hooks"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0425", `powershell.exe -NoProfile -Command "while ($true) { '' | cmd.exe /d /c exit }"`, 120, 40))
	b.mu.RLock()
	p := b.sessions[name].proc.(*windowsPTY)
	b.mu.RUnlock()
	root := p.cpty.Pid()
	start, ok := processStart(root)
	require.True(t, ok)
	p.agent.mu.Lock()
	p.agent.proc, p.agent.adopted = winProc{pid: root, start: start, known: true}, true
	p.agent.mu.Unlock()
	time.Sleep(time.Second) // the loop is running
	refusals := 0
	for i := 0; i < 100; i++ {
		if refused, why, _ := b.AgentTextRefused(name); refused {
			refusals++
			t.Logf("refused: %s", why)
		}
	}
	assert.Zero(t, refusals, "children that come and go with a pipe as their input never hold the agent's text")
}

// classifyKind is classifyProcess's answer alone.
func classifyKind(key stdinKey, wait time.Duration) stdinKind {
	k, _ := classifyProcess(key, wait)
	return k
}

// Deterministic (QA's #6908): a child the walk saw that has ended by the time it is probed is "gone", never "unreadable" (which would count as a reader).
func TestAChildThatEndedBeforeItsProbeIsGoneNotUnreadable(t *testing.T) {
	resetStdinMemo(t)
	t.Cleanup(func() { resetStdinMemo(t) })
	cmd := consoletest.HiddenCommand("cmd.exe", "/c", "ping -n 30 127.0.0.1 >nul")
	cmd.Stdin = bytes.NewReader(nil)
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	start, ok := processStart(pid) // what the walk's snapshot saw
	require.True(t, ok)
	_ = cmd.Process.Kill()
	_ = cmd.Wait() // it has ended before its probe
	l := &liveProcs{deadline: time.Now().Add(stdinWalkBudget)}
	assert.Equal(t, stdinGone, l.stdin(pid, start))
	stdinMemo.Lock()
	n := len(stdinMemo.m)
	stdinMemo.Unlock()
	assert.Zero(t, n, "nothing is kept for it as a reader")
}

// Security's #6919 point 2: through the real walk and probe, a live child below the agent whose process cannot be opened (access denied) is a reader, and is not taken for gone.
func TestALiveChildThatCannotBeOpenedIsAReader(t *testing.T) {
	resetStdinMemo(t)
	t.Cleanup(func() { resetStdinMemo(t) })
	cmd := consoletest.HiddenCommand("cmd.exe", "/c", "ping -n 30 127.0.0.1 >nul")
	cmd.Stdin = bytes.NewReader(nil) // a pipe: readable, it would not be a reader
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	child := cmd.Process.Pid
	deny := func(pid int) error {
		if pid == child {
			return windows.ERROR_ACCESS_DENIED
		}
		return nil
	}
	probeOpenHook.Store(&deny)
	t.Cleanup(func() { probeOpenHook.Store(nil) })

	src, err := newLiveProcs()
	require.NoError(t, err)
	me := os.Getpid()
	start, ok := processStart(me)
	require.True(t, ok)
	p, reads := consoleReaderBelow(src, winProc{pid: me, start: start, known: true})
	require.True(t, reads, "the denied child is a reader")
	assert.Equal(t, child, p.pid)

	probeOpenHook.Store(nil)
	resetStdinMemo(t)
	src, err = newLiveProcs()
	require.NoError(t, err)
	assert.Equal(t, stdinNotConsole, src.stdin(child, func() int64 { s, _ := processStart(child); return s }()), "the same child, opened: a pipe")
}

// A 32-bit process (git-credential-manager is one) is judged by its real standard input, read from its own 32-bit block: Windows' own 32-bit cmd with a pipe, or NUL, is not a reader.
func TestA32BitProcessIsJudgedByItsRealStandardInput(t *testing.T) {
	cmd32 := filepath.Join(os.Getenv("SystemRoot"), "SysWOW64", "cmd.exe")
	if _, err := os.Stat(cmd32); err != nil {
		t.Skipf("no 32-bit cmd on this Windows: %v", err)
	}
	for name, withPipe := range map[string]bool{"a pipe": true, "NUL": false} {
		t.Run(name, func(t *testing.T) {
			cmd := consoletest.HiddenCommand(cmd32, "/c", "ping -n 30 127.0.0.1 >nul")
			if withPipe {
				cmd.Stdin = bytes.NewReader(nil)
			}
			require.NoError(t, cmd.Start())
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(cmd.Process.Pid))
			require.NoError(t, err)
			var wow bool
			require.NoError(t, windows.IsWow64Process(h, &wow))
			windows.CloseHandle(h)
			require.True(t, wow, "the test's process is a 32-bit one")
			var got stdinKind
			assert.Eventually(t, func() bool { got = probeStdin(cmd.Process.Pid); return got == stdinNotConsole }, 5*time.Second, 50*time.Millisecond, "got %v", got)
		})
	}
}

// The console case for a 32-bit process: a terminal whose shell is the 32-bit cmd reads the console.
func TestA32BitShellOnTheConsoleIsAReader(t *testing.T) {
	cmd32 := filepath.Join(os.Getenv("SystemRoot"), "SysWOW64", "cmd.exe")
	if _, err := os.Stat(cmd32); err != nil {
		t.Skipf("no 32-bit cmd on this Windows: %v", err)
	}
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-0425-cmd32"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0425", `"`+cmd32+`" /d /q`, 120, 40))
	b.mu.RLock()
	pid := b.sessions[name].proc.(*windowsPTY).cpty.Pid()
	b.mu.RUnlock()
	var got stdinKind
	assert.Eventually(t, func() bool { got = probeStdin(pid); return got == stdinConsole }, 10*time.Second, 100*time.Millisecond, "got %v", got)
}

// Security's #6931: the 32-bit offsets are pinned (they are not the 64-bit ones), INVALID_HANDLE_VALUE and 0 are "no standard input" in both layouts and never a handle to duplicate,
// and this host is x64 (where the 32-bit layout is read).
func TestThe32BitLayoutIsPinnedAndNoHandleIsNeverDuplicated(t *testing.T) {
	assert.Equal(t, 0x10, peb32ProcessParameters)
	assert.Equal(t, 0x18, params32StandardInput)
	assert.Equal(t, uintptr(0x20), unsafe.Offsetof(windows.PEB{}.ProcessParameters), "the 64-bit PEB: not the 32-bit offset")
	assert.Equal(t, uintptr(0x20), unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.StandardInput), "the 64-bit parameters: not the 32-bit offset")
	assert.Equal(t, windows.InvalidHandle, handle32(0xFFFFFFFF))
	assert.Equal(t, windows.Handle(0x68), handle32(0x68))
	assert.True(t, noStdin(0))
	assert.True(t, noStdin(handle32(0xFFFFFFFF)))
	assert.False(t, noStdin(0x68))
	if runtime.GOARCH == "amd64" {
		assert.True(t, hostIsAMD64(), "this x64 test host reads 32-bit blocks")
	}
}
