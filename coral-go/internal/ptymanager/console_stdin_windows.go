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

func (l *liveProcs) stdin(pid int) stdinKind {
	start, ok := processStart(pid)
	if !ok {
		return stdinUnreadable
	}
	wait := time.Until(l.deadline)
	if l.deadline.IsZero() {
		wait = stdinWalkBudget
	}
	if wait <= 0 {
		return stdinUnreadable // the walk's budget is spent
	}
	return classifyProcess(stdinKey{pid, start}, wait)
}

// classifyProcess is the memoized answer for the process key, waiting at most wait for a probe; no answer in time, or no free worker, is a reader.
func classifyProcess(key stdinKey, wait time.Duration) stdinKind {
	stdinMemo.Lock()
	e := stdinMemo.m[key]
	if e == nil {
		if stdinMemo.workers >= stdinWorkersMax {
			stdinMemo.Unlock()
			return stdinUnreadable
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
		return e.kind
	case <-t.C:
		return stdinUnreadable
	}
}

// probeStdin reads and classifies the standard input of process pid.
func probeStdin(pid int) stdinKind {
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
