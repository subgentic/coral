//go:build windows

package ptymanager

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// What a process's standard input is (consoleReaderBelow): read from the process's own parameters (its PEB's RTL_USER_PROCESS_PARAMETERS.StandardInput), the handle duplicated into this
// process, then its file type and, for a character device, whether it is a console handle (GetConsoleMode succeeds only on one). Anything that cannot be read or told apart is
// stdinUnreadable, which counts as reading the console. A 32-bit process (its parameters have another layout) is not read and so counts as one too.
//
// Never a call that waits on the handle: the object's name (NtQueryObject) is not asked, because on a console handle another process is reading from (a cmd at its prompt, in
// ReadConsole) it does not return until that read ends. GetFileType and GetConsoleMode answer at once. And no caller waits on a probe for long: each runs on a worker, at most
// stdinWorkersMax at a time, its answer kept per process (pid and creation time); a walk gives all its probes stdinWalkBudget together, and a probe not answered in time, or not
// started because the workers are all busy, counts as a reader. A probe that never returns holds its worker, and its process is answered from the memo ("still probing": a reader)
// without another worker.

const (
	stdinWalkBudget = time.Second // all the probes of one walk
	stdinWorkersMax = 4
	stdinMemoMax    = 1024
)

// stdinProbeHook, when set, replaces the probe (a test's; an atomic, as a worker an earlier test left may still read it).
var stdinProbeHook atomic.Pointer[func(int) stdinKind]

// stdinProbe is the probe: probeStdin, or a test's hook.
func stdinProbe(pid int) stdinKind {
	if f := stdinProbeHook.Load(); f != nil {
		return (*f)(pid)
	}
	return probeStdin(pid)
}

type stdinKey struct {
	pid   int
	start int64
}

type stdinEntry struct {
	done chan struct{}
	kind stdinKind // set before done is closed
}

var stdinMemo = struct {
	sync.Mutex
	m       map[stdinKey]*stdinEntry
	workers int
}{m: map[stdinKey]*stdinEntry{}}

func (l *liveProcs) stdin(pid int, seen int64) stdinKind {
	if processGone(pid, seen) {
		return stdinGone
	}
	start, ok := processStart(pid)
	if !ok {
		return stdinUnreadable // alive (processGone said so) and its times cannot be read: fail closed
	}
	deadline := l.deadline
	if deadline.IsZero() {
		deadline = time.Now().Add(stdinWalkBudget)
	}
	key := stdinKey{pid, start}
	for try := 0; ; try++ {
		wait := time.Until(deadline)
		if wait <= 0 {
			return stdinUnreadable // the walk's budget is spent: a reader
		}
		k, answered := classifyProcess(key, wait)
		if k != stdinUnreadable || !answered {
			return k // an answer, or none in time or no free worker: a reader (Security's #6911 point 2)
		}
		// The probe answered "unreadable": is the process still there? (Security's #6911 point 1)
		if processGone(pid, start) {
			forgetStdin(key) // stored as gone, never as a reader (point 4)
			return stdinGone // it ended while it was probed: a hook that ran and finished
		}
		// A process moments old may not have its parameters yet: probed once more, inside the budget (point 3).
		if try > 0 || time.Since(filetimeTime(start)) > youngProcess || time.Until(deadline) <= youngRetry {
			return stdinUnreadable // alive and unreadable: a reader
		}
		forgetStdin(key)
		time.Sleep(youngRetry)
	}
}

// youngProcess and youngRetry: a process this young whose probe fails is probed once more after youngRetry.
const (
	youngProcess = 500 * time.Millisecond
	youngRetry   = 100 * time.Millisecond
)

// forgetStdin drops the memo's answer for key, once it is answered (a probe still running keeps its entry).
func forgetStdin(key stdinKey) {
	stdinMemo.Lock()
	defer stdinMemo.Unlock()
	if e := stdinMemo.m[key]; e != nil {
		select {
		case <-e.done:
			delete(stdinMemo.m, key)
		default:
		}
	}
}

// filetimeTime is a Windows file time (100 ns steps since 1601) as a time.
func filetimeTime(ft int64) time.Time {
	f := windows.Filetime{HighDateTime: uint32(ft >> 32), LowDateTime: uint32(ft)}
	return time.Unix(0, f.Nanoseconds())
}

// processGone says pid names no running process, or a process created at another time than start (0: not compared): it has ended, or its pid was reused. A process that is there
// but cannot be opened (access denied) is not gone: it stays unreadable, a reader.
func processGone(pid int, start int64) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_INVALID_PARAMETER) // no such process
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) == nil && code != stillActiveCode {
		return true
	}
	if start == 0 {
		return false
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil {
		return false
	}
	return int64(created.HighDateTime)<<32|int64(created.LowDateTime) != start
}

// stillActiveCode is the exit code GetExitCodeProcess reports for a process that has not ended (STILL_ACTIVE).
const stillActiveCode = 259

// classifyProcess is the memoized answer for the process key, waiting at most wait for a probe; no answer in time, or no free worker, is a reader. answered says the probe itself
// gave the answer (and not the wait or the pool).
func classifyProcess(key stdinKey, wait time.Duration) (stdinKind, bool) {
	stdinMemo.Lock()
	e := stdinMemo.m[key]
	if e == nil {
		if stdinMemo.workers >= stdinWorkersMax {
			stdinMemo.Unlock()
			return stdinUnreadable, false
		}
		if len(stdinMemo.m) >= stdinMemoMax {
			for k, old := range stdinMemo.m {
				select {
				case <-old.done:
					delete(stdinMemo.m, k) // answered: asked again when needed
				default: // a probe still running keeps its entry, so its process gets no second worker
				}
			}
		}
		e = &stdinEntry{done: make(chan struct{})}
		stdinMemo.m[key] = e
		stdinMemo.workers++
		go func() {
			k := stdinUnreadable // a fault in the probe is "unreadable", a reader: it never takes the server down
			func() {
				defer func() { _ = recover() }()
				k = stdinProbe(key.pid)
			}()
			stdinMemo.Lock()
			stdinMemo.workers--
			stdinMemo.Unlock()
			e.kind = k
			close(e.done)
		}()
	}
	stdinMemo.Unlock()
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-e.done:
		return e.kind, true
	case <-t.C:
		return stdinUnreadable, false
	}
}

// probeStdin reads and classifies the standard input of process pid.
func probeStdin(pid int) stdinKind {
	if f := probeOpenHook.Load(); f != nil {
		if err := (*f)(pid); err != nil {
			return stdinUnreadable // as the real open's failure
		}
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ|windows.PROCESS_DUP_HANDLE, false, uint32(pid))
	if err != nil {
		return stdinUnreadable
	}
	defer windows.CloseHandle(h)
	var wow bool
	if err := windows.IsWow64Process(h, &wow); err != nil || wow {
		return stdinUnreadable
	}
	var pbi windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(h, windows.ProcessBasicInformation, unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), nil); err != nil || pbi.PebBaseAddress == nil {
		return stdinUnreadable
	}
	var peb windows.PEB
	if !readProcess(h, uintptr(unsafe.Pointer(pbi.PebBaseAddress)), unsafe.Pointer(&peb), unsafe.Sizeof(peb)) || peb.ProcessParameters == nil {
		return stdinUnreadable
	}
	var params windows.RTL_USER_PROCESS_PARAMETERS
	if !readProcess(h, uintptr(unsafe.Pointer(peb.ProcessParameters)), unsafe.Pointer(&params), unsafe.Sizeof(params)) {
		return stdinUnreadable
	}
	if params.StandardInput == 0 {
		return stdinNotConsole // no standard input at all
	}
	var dup windows.Handle
	if err := windows.DuplicateHandle(h, params.StandardInput, windows.CurrentProcess(), &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return stdinUnreadable
	}
	defer windows.CloseHandle(dup)
	return classifyStdin(dup)
}

// probeOpenHook, when set, answers for the probe's OpenProcess first: an error is what the open would have failed with (a test's access denied).
var probeOpenHook atomic.Pointer[func(pid int) error]

// consoleModeHook, when set, replaces GetConsoleMode (a test's; an atomic, as a worker may still read it).
var consoleModeHook atomic.Pointer[func(windows.Handle) error]

// consoleMode is GetConsoleMode's answer for h (only whether it took it).
func consoleMode(h windows.Handle) error {
	if f := consoleModeHook.Load(); f != nil {
		return (*f)(h)
	}
	var mode uint32
	return windows.GetConsoleMode(h, &mode)
}

// readProcess reads size bytes at addr of process h into out; false unless all of them were read.
func readProcess(h windows.Handle, addr uintptr, out unsafe.Pointer, size uintptr) bool {
	var n uintptr
	return windows.ReadProcessMemory(h, addr, (*byte)(out), size, &n) == nil && n == size
}

// classifyStdin tells a handle apart: a pipe or a file is not the console; a character device is the console when GetConsoleMode takes it (it does for a console input or output
// handle of any console), is not when GetConsoleMode answers ERROR_INVALID_HANDLE (NUL, a serial port), and is unreadable, so a reader, on any other answer. Neither call waits on a
// read another process has pending.
func classifyStdin(h windows.Handle) stdinKind {
	t, err := windows.GetFileType(h)
	if err != nil && t == windows.FILE_TYPE_UNKNOWN {
		return stdinUnreadable
	}
	switch t {
	case windows.FILE_TYPE_PIPE, windows.FILE_TYPE_DISK:
		return stdinNotConsole
	case windows.FILE_TYPE_CHAR:
		switch err := consoleMode(h); {
		case err == nil:
			return stdinConsole
		case errors.Is(err, windows.ERROR_INVALID_HANDLE):
			return stdinNotConsole // not a console handle: NUL, a serial port
		}
		return stdinUnreadable // any other answer cannot say it is not the console
	}
	return stdinUnreadable
}
