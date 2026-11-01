//go:build windows

package ptymanager

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/safego"
)

// What a process's standard input is (consoleReaderBelow): read from the process's own parameters (its PEB's RTL_USER_PROCESS_PARAMETERS.StandardInput), the handle duplicated into this
// process, then its file type and, for a character device, whether it is a console handle (GetConsoleMode succeeds only on one). Anything that cannot be read or told apart is
// stdinUnreadable, which counts as reading the console. A 32-bit process is read from its own 32-bit parameter block (stdin32).
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
			defer safego.Recover("console stdin probe")
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
	if err := windows.IsWow64Process(h, &wow); err != nil {
		return stdinUnreadable
	}
	var in windows.Handle
	var ok bool
	if wow {
		if !hostIsAMD64() {
			return stdinUnreadable // a 32-bit process on another host (ARM64): its layout is not guessed, so it counts as a reader (Security's #6931)
		}
		in, ok = stdin32(h) // a 32-bit process (git-credential-manager is one): its own 32-bit block
	} else {
		in, ok = stdin64(h)
	}
	if !ok {
		return stdinUnreadable
	}
	switch {
	case in == 0:
		return stdinNotConsole // no standard input at all
	case in == windows.InvalidHandle:
		return stdinUnreadable // INVALID_HANDLE_VALUE: never duplicated (it is the pseudo-handle of the process itself); it cannot say what the input is, so a reader (Security's #6936 A)
	}
	var dup windows.Handle
	if err := windows.DuplicateHandle(h, in, windows.CurrentProcess(), &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return stdinUnreadable
	}
	defer windows.CloseHandle(dup)
	return classifyStdin(dup)
}

// stdin64 is a 64-bit process's standard input handle, from its PEB's RTL_USER_PROCESS_PARAMETERS.
func stdin64(h windows.Handle) (windows.Handle, bool) {
	var pbi windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(h, windows.ProcessBasicInformation, unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), nil); err != nil || pbi.PebBaseAddress == nil {
		return 0, false
	}
	var peb windows.PEB
	if !readProcess(h, uintptr(unsafe.Pointer(pbi.PebBaseAddress)), unsafe.Pointer(&peb), unsafe.Sizeof(peb)) || peb.ProcessParameters == nil {
		return 0, false
	}
	var params windows.RTL_USER_PROCESS_PARAMETERS
	if !readProcess(h, uintptr(unsafe.Pointer(peb.ProcessParameters)), unsafe.Pointer(&params), unsafe.Sizeof(params)) {
		return 0, false
	}
	return params.StandardInput, true
}

// The 32-bit layouts a WoW64 process keeps its parameters in: PEB32.ProcessParameters at 0x10, and in RTL_USER_PROCESS_PARAMETERS32 (MaximumLength, Length, Flags, DebugFlags,
// ConsoleHandle, ConsoleFlags, then the standard handles) StandardInput at 0x18. Each is a 32-bit value.
const (
	peb32ProcessParameters = 0x10
	params32StandardInput  = 0x18
)

// stdin32 is a 32-bit (WoW64) process's standard input handle, from its own 32-bit PEB (ProcessWow64Information gives its address) and RTL_USER_PROCESS_PARAMETERS32.
func stdin32(h windows.Handle) (windows.Handle, bool) {
	var peb32 uintptr
	if err := windows.NtQueryInformationProcess(h, windows.ProcessWow64Information, unsafe.Pointer(&peb32), uint32(unsafe.Sizeof(peb32)), nil); err != nil || peb32 == 0 {
		return 0, false
	}
	var params32 uint32
	if !readProcess(h, peb32+peb32ProcessParameters, unsafe.Pointer(&params32), unsafe.Sizeof(params32)) || params32 == 0 {
		return 0, false
	}
	var in uint32
	if !readProcess(h, uintptr(params32)+params32StandardInput, unsafe.Pointer(&in), unsafe.Sizeof(in)) {
		return 0, false
	}
	return handle32(in), true
}

// handle32 is a 32-bit process's handle value as one of this process: INVALID_HANDLE_VALUE (0xFFFFFFFF) stays INVALID_HANDLE_VALUE, never the 64-bit value 0xFFFFFFFF; 0 stays 0.
func handle32(v uint32) windows.Handle {
	if v == 0xFFFFFFFF {
		return windows.InvalidHandle
	}
	return windows.Handle(v)
}

// imageFileMachineAMD64 is IMAGE_FILE_MACHINE_AMD64.
const imageFileMachineAMD64 = 0x8664

// hostIsAMD64 says Windows itself runs on x64 (IsWow64Process2's native machine), the only host whose 32-bit (WoW64) layout is read; anything else, or a host that cannot say, keeps
// the 32-bit process a reader.
var hostIsAMD64 = sync.OnceValue(func() bool {
	var process, native uint16
	return windows.IsWow64Process2(windows.CurrentProcess(), &process, &native) == nil && native == imageFileMachineAMD64
})

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
