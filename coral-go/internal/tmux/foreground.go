package tmux

import (
	"context"
	"fmt"
	"github.com/subgentic/coral/internal/executil"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// shellNames are the interactive shells an agent's terminal starts with. The
// agent CLI is typed into that shell at launch, so when the CLI exits the
// terminal is left at a plain shell prompt (#3219).
var shellNames = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ksh": true, "mksh": true,
	"tcsh": true, "csh": true, "ash": true, "nu": true, "xonsh": true, "elvish": true,
	"pwsh": true, "powershell": true, "cmd": true,
}

// IsShellCommand reports whether a process name is a plain shell (a login
// shell's leading '-' and any directory or .exe are ignored).
func IsShellCommand(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	n = strings.TrimPrefix(n, "-")
	n = strings.TrimSuffix(filepath.Base(n), ".exe")
	return shellNames[n]
}

// ShellIdle reports whether the process with this pid, a terminal's own shell,
// is a shell with no child processes: nothing (no agent CLI, no wrapper script
// running one) is running in it, so the agent has exited (#3219). Checking for
// children rather than the foreground name keeps a CLI started through a shell
// wrapper script (which shows as 'bash' or 'sh') from looking exited. Unix only:
// it reads the process table from ps, one snapshot shared by the checks of every
// agent made within procTableTTL (#3728: three ps/pgrep runs per agent every 30 s).
//
// agent, when given, is wrapperIsCLI for the session's resolved CLI: a foreground shell that runs exactly that file is the agent (ShellRunning), not a nested shell (#408). It is never a
// test on the shell's name or on "a script argument": a person's `sh other.sh` stays a nested shell.
func ShellIdle(pid int, agent ...func(pid int) bool) (idle bool, shell string, err error) {
	if pid <= 0 {
		return false, "", fmt.Errorf("no shell pid")
	}
	procs, err := readProcTable()
	if err != nil {
		return false, "", fmt.Errorf("read process %d: %w", pid, err)
	}
	p, ok := procs.byPID[pid]
	if !ok && time.Since(procs.at) > 20*time.Millisecond && freshLookAllowed(pid) { // (a snapshot taken by this call is as fresh as it gets)
		// A shell started since the snapshot (a restart's new terminal) is not in it: look again, now, before an unknown shell counts as a running
		// agent and automated text is typed into a bare shell (#5171, #5170).
		if procs, err = readProcTableFresh(); err != nil {
			return false, "", fmt.Errorf("read process %d: %w", pid, err)
		}
		p, ok = procs.byPID[pid]
	}
	if !ok {
		return false, "", fmt.Errorf("read process %d: no such process", pid)
	}
	shell = p.comm
	if !IsShellCommand(shell) {
		return false, shell, nil // the terminal's process is the agent itself (it was exec'd)
	}
	state, _ := classifyShell(procs, pid, agent...)
	// Three answers (Security on #387/#388): ShellRunning is the agent (a foreground non-shell program that is a direct child of the pane's shell); ShellBare is a prompt with nothing
	// in it; ShellNested is a shell a person started, whatever runs under it. For ShellIdle both of the last two are "not the agent": nothing is typed as a notice. The launch-line
	// paths tell them apart (NestedShell): a bare prompt gets its launch line, a nested shell is "a shell of unknown contents" and gets none.
	return state != ShellRunning, shell, nil
}

// ShellState is what is in the foreground of an agent's pane.
type ShellState int

const (
	ShellBare    ShellState = iota // the pane's shell at its prompt: the agent CLI has exited
	ShellRunning                   // a foreground non-shell program is a direct child of the pane's shell: the agent
	ShellNested                    // a shell below the pane's shell that the terminal is in (at its prompt, or running a command): not the agent, whatever runs in it
)

// NestedShell is the name of the nested shell in the agent's pane (ShellNested), "" when the pane is not in one.
func (c *Client) NestedShell(ctx context.Context, agentName, agentType, sessionID string) (string, error) {
	pid, err := c.agentShellPID(ctx, agentName, agentType, sessionID)
	if err != nil {
		return "", err
	}
	return NestedShellOf(pid, WrapperCheckFor(agentName))
}

// NestedShellOf is NestedShell for a shell pid (also the Unix pseudo-terminal's).
func NestedShellOf(pid int, agent ...func(pid int) bool) (string, error) {
	procs, err := readProcTable()
	if err != nil {
		return "", fmt.Errorf("read process %d: %w", pid, err)
	}
	if _, ok := procs.byPID[pid]; !ok || !IsShellCommand(procs.byPID[pid].comm) {
		return "", nil
	}
	if state, nested := classifyShell(procs, pid, agent...); state == ShellNested {
		return nested, nil
	}
	return "", nil
}

// nestedShellDepth bounds the walk below the pane's shell (a shell inside a shell inside ...). A deeper tree is not walked to the end and counts as a nested shell.
const nestedShellDepth = 8

// classifyShell tells what is in the foreground of the shell pid. A foreground non-shell DIRECT child is the agent (ShellRunning), whatever else there is. Otherwise any shell reached
// through shells alone (never through a program: an agent's own bash tool is below the agent) that the terminal is in, at its prompt ('+') or running a command (a foreground program
// below it), is ShellNested, whatever runs under it. A background job, or a shell with neither, is not in the foreground and is nothing.
func classifyShell(t *procTable, pid int, agent ...func(pid int) bool) (ShellState, string) {
	isAgent := firstAgent(agent)
	for _, c := range t.children[pid] {
		e := t.byPID[c]
		if strings.Contains(e.stat, "+") && (!IsShellCommand(e.comm) || (isAgent != nil && isAgent(c))) { // (a shell is the agent only when it runs exactly the resolved CLI, #408)
			return ShellRunning, ""
		}
	}
	if sh := nestedShellBelow(t, pid, 0, map[int]bool{}); sh != "" {
		return ShellNested, sh
	}
	return ShellBare, ""
}

// nestedShellBelow is the name of the first shell below pid (through shells) that the terminal is in; "" when none. A walk that gets deeper than the bound names "shell".
func nestedShellBelow(t *procTable, pid, depth int, seen map[int]bool) string {
	if seen[pid] {
		return ""
	}
	seen[pid] = true
	if depth > nestedShellDepth {
		return "shell"
	}
	for _, c := range t.children[pid] {
		e := t.byPID[c]
		if !IsShellCommand(e.comm) {
			continue
		}
		if strings.Contains(e.stat, "+") || programBelowShells(t, c, depth+1, seen) {
			return e.comm
		}
		if sh := nestedShellBelow(t, c, depth+1, seen); sh != "" {
			return sh
		}
	}
	return ""
}

// programBelowShells: a foreground non-shell program below pid, through shells alone.
func programBelowShells(t *procTable, pid, depth int, seen map[int]bool) bool {
	if depth > nestedShellDepth {
		return true
	}
	for _, c := range t.children[pid] {
		e := t.byPID[c]
		if IsShellCommand(e.comm) {
			if programBelowShells(t, c, depth+1, seen) {
				return true
			}
		} else if strings.Contains(e.stat, "+") {
			return true
		}
	}
	return false
}

type procEntry struct {
	ppid  int
	stat  string
	comm  string
	start string // ps lstart ("Wed Oct 29 13:46:00 2026"): with the pid it names one process for good, "" when the table has none (#389)
}

var weekdays = map[string]bool{"Mon": true, "Tue": true, "Wed": true, "Thu": true, "Fri": true, "Sat": true, "Sun": true}

type procTable struct {
	byPID    map[int]procEntry
	children map[int][]int
	at       time.Time
}

// freshLookAllowed lets one fresh process-table read per pid per second through: a pid that is not there (a pane that is gone) must not make every check
// of it run ps.
func freshLookAllowed(pid int) bool {
	freshLookMu.Lock()
	defer freshLookMu.Unlock()
	now := time.Now()
	if t, ok := freshLooks[pid]; ok && now.Sub(t) < time.Second {
		return false
	}
	if len(freshLooks) > 1024 { // forget the old ones
		for k, t := range freshLooks {
			if now.Sub(t) >= time.Second {
				delete(freshLooks, k)
			}
		}
	}
	freshLooks[pid] = now
	return true
}

var (
	freshLookMu sync.Mutex
	freshLooks  = map[int]time.Time{}
)

// procTableTTL is how long a process-table snapshot answers: long enough to serve one
// reconciler pass over every agent, short enough that an exit is seen on the next pass.
const procTableTTL = time.Second

var (
	procTableMu   sync.Mutex
	procTableLast *procTable
	// procTableRuns counts the ps runs, for tests.
	procTableRuns atomic.Int64
)

// readProcTable returns a snapshot of every process (pid, parent, state, command) no older
// than procTableTTL, from one 'ps' run.
// psTimeout bounds the ps call: readProcTable holds procTableMu while it runs, so a stuck ps would
// block every caller for good (#3999, the #3994 audit finding 4).
var psTimeout = 5 * time.Second

func readProcTable() (*procTable, error) { return readProcTableMaxAge(procTableTTL) }

// readProcTableFresh is a snapshot taken now.
func readProcTableFresh() (*procTable, error) { return readProcTableMaxAge(0) }

func readProcTableMaxAge(maxAge time.Duration) (*procTable, error) {
	procTableMu.Lock()
	defer procTableMu.Unlock()
	if t := procTableLast; t != nil && maxAge > 0 && time.Since(t.at) < maxAge {
		return t, nil
	}
	procTableRuns.Add(1)
	out, err := executil.Output(psTimeout, "ps", "-A", "-o", "pid=,ppid=,stat=,lstart=,comm=")
	if err != nil {
		return nil, err
	}
	t := parseProcTable(string(out))
	t.at = time.Now()
	procTableLast = t
	return t, nil
}

// parseProcTable reads 'ps -A -o pid=,ppid=,stat=,lstart=,comm=' (or the same without lstart): the start time is the five words after the state when the
// first of them is a weekday, and the command is the rest of the line (a macOS command is a path, which may hold spaces).
func parseProcTable(out string) *procTable {
	t := &procTable{byPID: map[int]procEntry{}, children: map[int][]int{}}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		skip, start := 3, "" // past pid, ppid and stat
		if len(f) >= 9 && weekdays[f[3]] {
			skip, start = 8, strings.Join(f[3:8], " ") // ... and the five words of lstart
		}
		rest := strings.TrimLeft(line, " \t")
		for k := 0; k < skip; k++ {
			rest = strings.TrimLeft(rest[strings.IndexAny(rest, " \t"):], " \t")
		}
		t.byPID[pid] = procEntry{ppid: ppid, stat: f[2], comm: strings.TrimSpace(rest), start: start}
		t.children[ppid] = append(t.children[ppid], pid)
	}
	return t
}

// AgentShellIdle reports whether the agent's own pane is back at its idle shell
// prompt (ShellIdle on the pane's shell). It returns ErrTerminalGone when the
// pane is gone.
func (c *Client) AgentShellIdle(ctx context.Context, agentName, agentType, sessionID string) (bool, string, error) {
	pid, err := c.agentShellPID(ctx, agentName, agentType, sessionID)
	if err != nil {
		return false, "", err
	}
	return ShellIdle(pid, WrapperCheckFor(agentName))
}

// agentShellPID is the pid of the agent's pane's shell: from the shared pane list when it has the pane (#3847), else from tmux.
func (c *Client) agentShellPID(ctx context.Context, agentName, agentType, sessionID string) (int, error) {
	if st, ok := c.agentPaneState(ctx, agentName, agentType, sessionID); ok && st.pid > 0 {
		return st.pid, nil
	}
	out, err := c.DisplayForAgent(ctx, agentName, agentType, sessionID, "#{pane_pid}")
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("invalid pane pid %q: %w", out, err)
	}
	return pid, nil
}

// foregroundIsShell says whether the program in the foreground of the pane is a plain shell (pane_current_command).
// An unreadable answer is not a shell.
func (c *Client) foregroundIsShell(ctx context.Context, target string) bool {
	out, err := c.DisplayMessage(ctx, target, "#{pane_current_command}")
	return err == nil && IsShellCommand(strings.TrimSpace(out))
}
