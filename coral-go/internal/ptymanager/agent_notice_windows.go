//go:build windows

package ptymanager

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/tmux"
)

func init() { registerWatchStopper(StopWinAgentWatches) }

// liveProcs is the Windows process table as a procSource: one snapshot of who is whose child, and each process's image and creation time read through its handle when asked.
type liveProcs struct {
	kids map[int][]int
}

func newLiveProcs() (*liveProcs, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	l := &liveProcs{kids: map[int][]int{}}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return nil, err
	}
	for {
		if p, c := int(e.ParentProcessID), int(e.ProcessID); p != c {
			l.kids[p] = append(l.kids[p], c)
		}
		if err := windows.Process32Next(snap, &e); err != nil {
			break
		}
	}
	return l, nil
}

func (l *liveProcs) children(pid int) []int { return l.kids[pid] }

func (l *liveProcs) info(pid int) winProc {
	start, startOK := processStart(pid)
	image, imageOK := processImage(pid)
	p := winProc{pid: pid, start: start, known: startOK && imageOK}
	if !imageOK {
		return p
	}
	p.name = strings.TrimSuffix(strings.ToLower(filepath.Base(image)), ".exe")
	switch {
	case consoleHostImage(image):
		p.kind = kindConsoleHost
	case verifiedWindowsShell(image):
		p.kind = kindVerifiedShell
	case shellNamed(image):
		p.kind = kindUnknownShell
	}
	return p
}

// AdoptAgentAfterLaunch starts the watch for the session's agent process after a launch line was typed into the terminal (#389).
func (p *windowsPTY) AdoptAgentAfterLaunch(session string) {
	gen, ctx := p.agent.reset()
	winWatches.Add(1)
	safego.Go("conpty-adopt-agent", func() {
		defer winWatches.Done()
		p.agent.watch(ctx, gen, defaultAdoptTiming, func() (procSource, int, bool) {
			select {
			case <-p.done:
				return nil, 0, false
			default:
			}
			src, err := newLiveProcs()
			if err != nil {
				return nil, 0, false
			}
			return src, p.cpty.Pid(), true
		}, func(proc winProc, got bool) {
			if got {
				slog.Info("recorded the agent's process", "session", session, "pid", proc.pid)
			} else {
				slog.Warn("did not record the agent's process: board notices stay off until it is recorded (Wake it, or restart the agent)", "session", session)
			}
		})
	})
}

// NoteLaunch keeps the script Coral wrote for the session's launch and the CLI path it launched with (#391).
func (p *windowsPTY) NoteLaunch(script, cli string) { p.agent.noteLaunch(script, cli) }

// NoticeVerdict says whether a board notice may be typed into this terminal now: the recorded agent process is alive and the only program below the terminal's root.
func (p *windowsPTY) NoticeVerdict() (tmux.NoticeVerdict, error) {
	root := p.cpty.Pid()
	if root <= 0 {
		return tmux.NoticeVerdict{}, fmt.Errorf("no shell pid")
	}
	src, err := newLiveProcs()
	if err != nil {
		return tmux.NoticeVerdict{}, err
	}
	return p.agent.verdict(src, root), nil
}

// AgentCandidate is the single program in the terminal, shown to the Operator before "record as agent" (#391). Start is the creation time as a decimal string; Image is the program's path.
func (p *windowsPTY) AgentCandidate(cliPath string) (AgentCandidate, string, error) {
	root := p.cpty.Pid()
	if root <= 0 {
		return AgentCandidate{}, "", fmt.Errorf("no shell pid")
	}
	src, err := newLiveProcs()
	if err != nil {
		return AgentCandidate{}, "", err
	}
	c, why := candidateWinRule(src, root, p.agent.launchCLI(), p.agent.handoffPath())
	if why != "" {
		return AgentCandidate{}, why, nil
	}
	return winCandidate(c), "", nil
}

// RecordAgent records want as the terminal's agent process when it is still exactly the one program.
func (p *windowsPTY) RecordAgent(want AgentCandidate) (AgentCandidate, error) {
	root := p.cpty.Pid()
	if root <= 0 {
		return AgentCandidate{}, fmt.Errorf("no shell pid")
	}
	src, err := newLiveProcs()
	if err != nil {
		return AgentCandidate{}, err
	}
	start, perr := strconv.ParseInt(want.Start, 10, 64)
	if perr != nil {
		return AgentCandidate{}, ErrCandidateChanged
	}
	got, err := p.agent.recordWin(src, root, winProc{pid: want.PID, start: start, acknowledged: want.AcknowledgeNested}, want.CLIPath)
	if err != nil {
		return AgentCandidate{}, err
	}
	slog.Info("recorded the agent's process by the Operator's request", "pid", got.pid)
	return winCandidate(got), nil
}

func winCandidate(c winProc) AgentCandidate {
	image, _ := processImage(c.pid)
	out := winCandidateFields(c)
	out.Image = image
	out.Program, out.Folder, out.Unidentified = describeImage(c.pid, image)
	return out
}

// commandLine is a process's command line, read for one comparison (isLauncherCommandLine) and dropped. NtQueryInformationProcess with ProcessCommandLineInformation (class 60,
// Windows 8.1+) needs only PROCESS_QUERY_LIMITED_INFORMATION on a process of the same user; no process memory is read. A failure, or a line longer than launcherCmdMaxLine, is "not
// read", which the caller treats as a nested shell.
func (l *liveProcs) commandLine(pid int) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	size := uint32(2*launcherCmdMaxLine + 64) // UNICODE_STRING header plus the text
	buf := make([]byte, size)
	var need uint32
	r, _, _ := procNtQueryInformationProcess.Call(uintptr(h), processCommandLineInformation, uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&need)))
	if r != 0 { // including STATUS_BUFFER_OVERFLOW / STATUS_INFO_LENGTH_MISMATCH: longer than the buffer
		return "", false
	}
	us := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
	if us.Buffer == nil || us.Length == 0 {
		return "", false
	}
	line := us.String()
	if len(line) > launcherCmdMaxLine {
		return "", false
	}
	return line, true
}

// processCommandLineInformation is the ProcessCommandLineInformation class of NtQueryInformationProcess.
const processCommandLineInformation = 60

var procNtQueryInformationProcess = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryInformationProcess")

// launcherCheck is the test for a cmd under the terminal's root: its command line is exactly Coral's launcher for the CLI this session was launched with (isLauncherCommandLine). nil when
// no CLI is known, which recognises nothing.
func (a *winAgent) launcherCheck() func(pid int) bool {
	cli := a.launchCLI()
	if cli == "" {
		return nil
	}
	return func(pid int) bool {
		line, ok := (&liveProcs{}).commandLine(pid)
		return ok && isLauncherCommandLine(line, cli)
	}
}
