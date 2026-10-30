//go:build windows

package consoletest

import (
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// startTripwire notes the default terminal's console hosts running now (OpenConsole.exe or conhost.exe whose parent is a svchost.exe), and returns a check that names any
// started since.
func startTripwire() func() []string {
	before := handedConsoles()
	return func() []string {
		var extra []string
		for pid, what := range handedConsoles() {
			if _, ok := before[pid]; !ok {
				extra = append(extra, what)
			}
		}
		return extra
	}
}

func printTripwire(extra []string) {
	fmt.Fprintf(os.Stderr, "FAIL: a console window was opened during this package's tests (or the default terminal started one for something else on the machine meanwhile): %s\n", strings.Join(extra, ", "))
}

// handedConsoles are the console hosts Windows started for a console program that had none: OpenConsole.exe or conhost.exe with a svchost.exe parent, by pid.
func handedConsoles() map[uint32]string {
	out := map[uint32]string{}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return out
	}
	defer windows.CloseHandle(snap)
	names := map[uint32]string{}
	parents := map[uint32]uint32{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		names[e.ProcessID] = strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		parents[e.ProcessID] = e.ParentProcessID
	}
	for pid, name := range names {
		if (name == "openconsole.exe" || name == "conhost.exe") && names[parents[pid]] == "svchost.exe" {
			out[pid] = fmt.Sprintf("%s (pid %d, parent svchost %d)", name, pid, parents[pid])
		}
	}
	return out
}
