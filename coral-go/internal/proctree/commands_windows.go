//go:build windows

package proctree

import (
	"context"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CommandsBelow answers the image names ("go", "node") of the processes below root on Windows, from one Toolhelp snapshot, which is never a slow call and needs no command line: the tree is the parent links
// from the session's own recorded pid, never a name search (#13659). ok is false when the snapshot cannot be taken: the hook then gives the slot back when the call ends.
func CommandsBelow(ctx context.Context, root int) (cmds []string, ok bool) {
	if root <= 1 || ctx.Err() != nil {
		return nil, false
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var rows []SnapshotRow
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		rows = append(rows, SnapshotRow{PID: int(e.ProcessID), PPID: int(e.ParentProcessID), ExeFile: windows.UTF16ToString(e.ExeFile[:])})
		if len(rows) > 100000 { // a bound: no machine has this many, and the loop never runs away
			return nil, false
		}
	}
	return Below(FromSnapshot(rows), root), true
}

// Snapshot: not known on Windows for a hand claim (it follows its tool call alone).
func Snapshot(ctx context.Context) (procs []Proc, ok bool) { return nil, false }
