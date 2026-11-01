//go:build windows

package ptymanager

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// What a process's standard input is (consoleReaderBelow): read from the process's own parameters (its PEB's RTL_USER_PROCESS_PARAMETERS.StandardInput), the handle duplicated into this
// process, then its file type and, for a character device, its object name: \Device\ConDrv is the console, \Device\Null is not. Anything that cannot be read or told apart is
// stdinUnreadable, which counts as reading the console. A 32-bit process (its parameters have another layout) is not read and so counts as one too.

func (l *liveProcs) stdin(pid int) stdinKind { return processStdin(pid) }

func processStdin(pid int) stdinKind {
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

// readProcess reads size bytes at addr of process h into out; false unless all of them were read.
func readProcess(h windows.Handle, addr uintptr, out unsafe.Pointer, size uintptr) bool {
	var n uintptr
	return windows.ReadProcessMemory(h, addr, (*byte)(out), size, &n) == nil && n == size
}

// classifyStdin tells a handle apart: a pipe or a file is not the console; a character device is the console only when it is \Device\ConDrv, and not when it is \Device\Null. Its name is
// asked only of a character device: asking it of a pipe can block.
func classifyStdin(h windows.Handle) stdinKind {
	t, err := windows.GetFileType(h)
	if err != nil && t == windows.FILE_TYPE_UNKNOWN {
		return stdinUnreadable
	}
	switch t {
	case windows.FILE_TYPE_PIPE, windows.FILE_TYPE_DISK:
		return stdinNotConsole
	case windows.FILE_TYPE_CHAR:
		name := strings.ToLower(objectName(h))
		switch {
		case name == `\device\null`:
			return stdinNotConsole
		case name == `\device\condrv` || strings.HasPrefix(name, `\device\condrv\`):
			return stdinConsole
		}
	}
	return stdinUnreadable
}

var procNtQueryObject = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryObject")

// objectNameInformation is the ObjectNameInformation class of NtQueryObject.
const objectNameInformation = 1

// objectName is the kernel name of the object behind h ("\Device\ConDrv\..."), "" when it cannot be read.
func objectName(h windows.Handle) string {
	buf := make([]byte, 1024)
	var need uint32
	r, _, _ := procNtQueryObject.Call(uintptr(h), objectNameInformation, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&need)))
	if r != 0 {
		return ""
	}
	us := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
	if us.Buffer == nil || us.Length == 0 {
		return ""
	}
	return us.String()
}
