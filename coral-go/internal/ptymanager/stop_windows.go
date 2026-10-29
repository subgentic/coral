//go:build windows

package ptymanager

import (
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/tmux"
)

// newKillJob puts the process the terminal started into a job object that ends every process in it when the job is
// terminated or its handle closes, so a stop ends the whole tree (the shell, the agent and what the agent started), not only
// the process ConPTY was given (#68). The assignment is made right after the start, before the shell has started children.
// A failure gives 0: the stop then ends the pseudo console as before.
func newKillJob(pid int) windows.Handle {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		windows.CloseHandle(job)
		return 0
	}
	defer windows.CloseHandle(proc)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		windows.CloseHandle(job)
		return 0
	}
	return job
}

// hasChildProcesses says whether any process has parent pid (a snapshot of the process list).
func hasChildProcesses(pid int) (bool, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return false, err
	}
	for {
		if int(e.ParentProcessID) == pid {
			return true, nil
		}
		if err := windows.Process32Next(snap, &e); err != nil {
			return false, nil
		}
	}
}

// runsNonShell says whether any process under pid (its children, theirs, and so on, from one snapshot of the process list) is
// something other than a shell (powershell, pwsh, cmd, and the shells the Unix check knows, tmux.IsShellCommand: bash, sh, zsh, nu
// and the rest, so git-bash at the prompt counts as one) or a console host: a program is running there. Nested shells alone (a person typed "cmd" at
// the prompt an exited agent left, #378) are still a bare prompt, which would run typed text as a command. A process whose image
// can't be read counts as a program. A process is taken as a child only when it started after its parent: Windows reuses pids,
// and a process left by an earlier owner of the parent's pid is not under it. The walk visits each pid once and stops at
// maxShellTreeDepth levels, where what is left counts as a program.
func runsNonShell(pid int) (bool, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snap)
	children := map[int][]int{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return false, err
	}
	for {
		if p, c := int(e.ParentProcessID), int(e.ProcessID); p != c {
			children[p] = append(children[p], c)
		}
		if err := windows.Process32Next(snap, &e); err != nil {
			break
		}
	}
	rootStart, ok := processStart(pid)
	if !ok {
		return false, fmt.Errorf("read process %d", pid)
	}
	type node struct {
		pid   int
		start int64
		depth int
	}
	seen := map[int]bool{pid: true}
	queue := []node{{pid, rootStart, 0}}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		for _, c := range children[n.pid] {
			if seen[c] {
				continue
			}
			start, ok := processStart(c)
			if ok && start < n.start {
				continue // an earlier owner's process: this pid was reused
			}
			seen[c] = true
			image, imageOK := processImage(c)
			if imageOK && consoleHostImage(image) {
				continue // the console host of a program's own console, not a program the person runs (#205 review)
			}
			if !ok || !imageOK || !tmux.IsShellCommand(image) || n.depth+1 >= maxShellTreeDepth {
				return true, nil
			}
			queue = append(queue, node{c, start, n.depth + 1})
		}
	}
	return false, nil
}

// consoleHostImage says whether an image is Windows' console host (conhost.exe, or OpenConsole.exe, Windows Terminal's), which a
// console program can have as a child: it is not a program the person runs.
func consoleHostImage(image string) bool {
	switch strings.ToLower(filepath.Base(image)) {
	case "conhost.exe", "openconsole.exe":
		return true
	}
	return false
}

// maxShellTreeDepth bounds runsNonShell's walk: shells nested this deep are not a person at a prompt.
const maxShellTreeDepth = 16

// processStart is when a process started (its creation time, in 100 ns units); ok is false when it can't be read.
func processStart(pid int) (int64, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, false
	}
	return int64(created.HighDateTime)<<32 | int64(created.LowDateTime), true
}

// rootIsShell says whether the process the terminal started is a known shell (powershell, pwsh, cmd), read from the process's own
// executable path through its handle, never from the command line text. Any failure, or a process that is gone, is "no": the polite stop
// then types nothing (#5665).
func rootIsShell(pid int) bool {
	image, ok := processImage(pid)
	return ok && isShellImage(image)
}

// processImage is the full path of a process's executable, read through its handle; ok is false when it can't be read
// (the process is gone, or another user's).
func processImage(pid int) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_PATH*2)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return "", false
	}
	return windows.UTF16ToString(buf[:n]), true
}
