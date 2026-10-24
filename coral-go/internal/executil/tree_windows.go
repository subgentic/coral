//go:build windows

package executil

import (
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A CLI that is a .cmd shim (claude.cmd, codex.cmd) runs as cmd.exe /c, and the program it really runs (node.exe) is cmd.exe's child. When a timed run ends, Go ends only the process it
// started, so that child stayed running (#349). Windows has no process groups, and the callers of Output and Run have no hook between the start and the wait to put the command in a job
// object, so the end of the run finds the tree itself: the processes whose chain of parents leads to the command, each created after its parent (a recycled process id is never taken for
// a child).

type procEntry struct{ pid, ppid uint32 }

// collect is the descendants of root among procs. created gives a process's creation time, false when it cannot be read (such a process is left alone). Pure, so a test can drive it.
func collect(procs []procEntry, root uint32, created func(pid uint32) (time.Time, bool)) []uint32 {
	born, ok := created(root)
	if !ok {
		return nil
	}
	type node struct {
		pid  uint32
		born time.Time
	}
	var out []uint32
	seen := map[uint32]bool{root: true}
	queue := []node{{root, born}}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, p := range procs {
			if p.ppid != parent.pid || seen[p.pid] {
				continue
			}
			b, ok := created(p.pid)
			if !ok || b.Before(parent.born) {
				continue
			}
			seen[p.pid] = true
			out = append(out, p.pid)
			queue = append(queue, node{p.pid, b})
		}
	}
	return out
}

func snapshotProcesses() []procEntry {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if windows.Process32First(snap, &e) != nil {
		return nil
	}
	var out []procEntry
	for {
		out = append(out, procEntry{pid: e.ProcessID, ppid: e.ParentProcessID})
		if windows.Process32Next(snap, &e) != nil {
			return out
		}
	}
}

func createdAt(pid uint32) (time.Time, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return time.Time{}, false
	}
	defer windows.CloseHandle(h)
	var creation, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &creation, &exit, &kernel, &user) != nil {
		return time.Time{}, false
	}
	return time.Unix(0, creation.Nanoseconds()), true
}

// descendants is every process now running below pid.
func descendants(pid uint32) []uint32 {
	return collect(snapshotProcesses(), pid, createdAt)
}

// killTree ends pid and what it started. The children are found first (once pid is gone nothing says whose they were), and a second sweep finds what was started while the first
// was ending.
func killTree(pid uint32) {
	known := map[uint32]bool{}
	for pass := 0; pass < 3; pass++ {
		fresh := false
		for _, d := range descendants(pid) {
			if known[d] {
				continue
			}
			known[d] = true
			fresh = true
			terminate(d)
		}
		if !fresh {
			break
		}
	}
}

func terminate(pid uint32) {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return
	}
	_ = windows.TerminateProcess(h, 1)
	windows.CloseHandle(h)
}

// exited says whether the process is gone (or ending: Windows refuses to terminate one that is).
func exited(pid uint32) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return true
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev != uint32(windows.WAIT_TIMEOUT)
}

// killRoot ends the process Go started after its tree: a shim whose only child was just ended may already be ending by itself, and Windows answers "access denied" to that, which is the
// outcome that was wanted (os.ErrProcessDone, which Go ignores).
func killRoot(cmd interface{ Kill() error }, pid uint32) error {
	err := cmd.Kill()
	if err != nil && exited(pid) {
		return os.ErrProcessDone
	}
	return err
}
