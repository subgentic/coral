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

// shellTree reads what runs under pid (its children, theirs, and so on, from one snapshot of the process list), for ShellIdle:
//   - busy: a program runs there (an image that is not a shell, or one that can't be read): the agent, or a job the person left;
//   - other: no program was seen, but a shell other than a verified Windows PowerShell or cmd was (git-bash's bash, WSL's bash.exe or
//     wsl.exe, an MSYS2, Cygwin or Scoop shell, a pwsh at an unknown place). What runs inside such a shell can't be seen from Windows
//     (git-bash's children don't appear under it, measured), so the pane is "a shell of unknown contents" (Security on #216);
//   - neither: only PowerShell and cmd, nested or not, and console hosts: a bare prompt.
//
// A process is taken as a child only when it started after its parent: Windows reuses pids, and a process left by an earlier owner of
// the parent's pid is not under it. The walk visits each pid once and stops at maxShellTreeDepth levels, where what is left counts as a
// program. A shell of unknown contents covers everything under it: a program below it (WSL's processes, a Cygwin child that does show)
// is that shell's, not the agent's, so it leaves the pane "unknown contents" and notices are withheld (Security on #216). A program
// that is under no such shell (the agent: powershell, its script, the claude.cmd shim's cmd, node) is busy, as before.
//
// launcher, when given (the session's launcherCheck), says whether a verified cmd is Coral's launcher for the resolved CLI (isLauncherCommandLine): a direct child of the root that is
// one is the agent whether or not it has started a program below it (a .bat or .cmd that IS the CLI and blocks in a builtin has none), so the tree is busy (#408).
func shellTree(pid int, launcher ...func(pid int) bool) (busy bool, other string, err error) {
	var isLauncher func(pid int) bool
	if len(launcher) > 0 {
		isLauncher = launcher[0]
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, "", err
	}
	defer windows.CloseHandle(snap)
	children := map[int][]int{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return false, "", err
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
		return false, "", fmt.Errorf("read process %d", pid)
	}
	type node struct {
		pid   int
		start int64
		depth int
		under string // the shell of unknown contents this node is under ("" for none)
	}
	seen := map[int]bool{pid: true}
	queue := []node{{pid, rootStart, 0, ""}}
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
			isProgram := !ok || !imageOK || n.depth+1 >= maxShellTreeDepth
			switch {
			case isProgram && n.under != "", !isProgram && !verifiedWindowsShell(image) && !shellNamed(image) && n.under != "":
				continue // the unknown shell's own: the pane stays "unknown contents"
			case isProgram:
				return true, "", nil
			case verifiedWindowsShell(image):
				if isLauncher != nil && n.depth == 0 && n.under == "" && isLauncher(c) {
					return true, "", nil
				}
				queue = append(queue, node{c, start, n.depth + 1, n.under})
			case shellNamed(image):
				name := strings.TrimSuffix(strings.ToLower(filepath.Base(image)), ".exe")
				if other == "" {
					other = name
				}
				under := n.under
				if under == "" {
					under = name
				}
				queue = append(queue, node{c, start, n.depth + 1, under})
			default:
				return true, "", nil
			}
		}
	}
	return false, other, nil
}

// shellNamed says whether an image is named like a shell: the shells the Unix check knows (tmux.IsShellCommand: bash, sh, zsh, fish, nu
// and the rest, powershell, pwsh and cmd too) and wsl.exe, WSL's launcher. Where it is decides nothing here: verifiedWindowsShell does.
func shellNamed(image string) bool {
	return tmux.IsShellCommand(image) || strings.EqualFold(filepath.Base(image), "wsl.exe")
}

// verifiedWindowsShell says whether an image is Windows PowerShell, PowerShell 7 or cmd in its own fixed folder, never merely somewhere
// under the Windows folder (C:\Windows\Temp is writable by ordinary users, Security on #216):
//   - powershell.exe: System32\WindowsPowerShell\v1.0 or SysWOW64\WindowsPowerShell\v1.0 (and System32 or SysWOW64 themselves);
//   - cmd.exe: System32 or SysWOW64;
//   - pwsh.exe: Program Files\PowerShell\<version>.
//
// Compared cleaned and case-folded, folder by folder. Any other shell-named image is a shell of unknown contents (shellTree).
func verifiedWindowsShell(image string) bool {
	p := strings.ToLower(filepath.Clean(image))
	dir, base := filepath.Dir(p), filepath.Base(p)
	in := func(dirs ...string) bool {
		for _, d := range dirs {
			if dir == strings.ToLower(filepath.Clean(d)) {
				return true
			}
		}
		return false
	}
	switch base {
	case "powershell.exe", "cmd.exe":
		win, err := windows.GetSystemWindowsDirectory()
		if err != nil {
			return false
		}
		sys32, wow64 := filepath.Join(win, "System32"), filepath.Join(win, "SysWOW64")
		if base == "cmd.exe" {
			return in(sys32, wow64)
		}
		return in(sys32, wow64, filepath.Join(sys32, "WindowsPowerShell", "v1.0"), filepath.Join(wow64, "WindowsPowerShell", "v1.0"))
	case "pwsh.exe":
		pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
		return err == nil && filepath.Dir(dir) == strings.ToLower(filepath.Join(pf, "PowerShell"))
	}
	return false
}

// consoleHostImage says whether an image is Windows' console host, which a console program can have as a child and is not a program the
// person runs: conhost.exe in the Windows System32 folder, or Windows Terminal's OpenConsole.exe under Program Files\WindowsApps// Microsoft.WindowsTerminal*. By full path, compared cleaned and case-folded, the Terminal's by prefix: a program that only takes the name
// is still a program (Security on #205, #216).
func consoleHostImage(image string) bool {
	p := strings.ToLower(filepath.Clean(image))
	if win, err := windows.GetSystemWindowsDirectory(); err == nil && p == strings.ToLower(filepath.Join(win, "System32", "conhost.exe")) {
		return true
	}
	if filepath.Base(p) != "openconsole.exe" {
		return false
	}
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	return err == nil && strings.HasPrefix(p, strings.ToLower(filepath.Join(pf, "WindowsApps", "Microsoft.WindowsTerminal")))
}

// maxShellTreeDepth bounds shellTree's walk: shells nested this deep are not a person at a prompt.
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
