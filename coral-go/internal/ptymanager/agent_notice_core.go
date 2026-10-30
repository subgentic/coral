package ptymanager

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/tmux"
)

// The Windows half of "board notices are typed only into the session's recorded agent process" (#389). The pure part: the walk below the terminal's root shell over an abstract process
// source (so it is tested on any machine) and the decision. Windows has no foreground job, so "the agent is in the foreground" is "the agent is the only program in the tree": a program
// anywhere below the root (through verified shells, console hosts left out) that is not the recorded process means the terminal is not running the agent.

type procKind int

const (
	kindProgram       procKind = iota // anything that is not one of the below
	kindVerifiedShell                 // a PowerShell or cmd in its fixed system folder: the agent's own route can pass through one (claude.cmd runs under cmd)
	kindUnknownShell                  // bash.exe, wsl.exe, git-bash: what runs in it can't be seen (#216)
	kindConsoleHost                   // conhost.exe or the terminal's OpenConsole: the console of a program, not a program the person runs
)

// winProc is one process: its pid, its creation time (with the pid it names one process for good), what it is, and whether the system said (an unreadable one counts as a program).
type winProc struct {
	pid   int
	start int64
	kind  procKind
	known bool
	name  string // the image's base name, lower case, without .exe ("" when unreadable)
	via   string // set by programsBelow: the first shell on the way to this program ("" for a direct child of the terminal's root)
	// launched is set by programsBelow: the program was reached through Coral's recognised launcher cmd (whose /c target is the resolved CLI), so it is that CLI's own process (node behind claude.cmd).
	launched bool
	// acknowledged, on the winProc passed to recordWin, is the Operator's acknowledgement for a program under a nested shell.
	acknowledged bool
}

// procSource is the process table the walk reads (the live one on Windows, a table in the tests).
type procSource interface {
	children(pid int) []int
	info(pid int) winProc
	// commandLine is a process's command line, only to be compared (isLauncherCommandLine) and dropped; ok is false when it cannot be read (or is longer than launcherCmdMaxLine).
	commandLine(pid int) (cmdline string, ok bool)
}

const maxWinWalkDepth = 16

// programsBelow is programsBelowCLI without a resolved CLI: no cmd counts as the agent's launcher.
func programsBelow(src procSource, root int) (progs []winProc, unknown string, deep bool) {
	return programsBelowCLI(src, root, "")
}

// programsBelowCLI lists the programs below root, walking through verified shells: not shells, not console hosts, not what runs under a shell of unknown contents (that shell's own:
// unknown is its name, and the pane stays "unknown contents"). A child created before its parent is an earlier owner's pid, reused, and is left out. deep is true when the walk hit its
// bound. Each program carries via: the first shell on the way ("" for a direct child of root). The cmd that is the agent's own launcher (cli is the resolved CLI path; see
// isLauncherCommandLine) is not counted as a shell on the way, when it is a direct child of root with no sibling program.
func programsBelowCLI(src procSource, root int, cli string) (progs []winProc, unknown string, deep bool) {
	return programsBelowRule(src, root, cli, "")
}

// programsBelowRule is programsBelowCLI that also recognises Coral's own handoff PowerShell (#391): a verified PowerShell that is a direct child of root, with no sibling program, whose
// command line is exactly isHandoffCommandLine for handoff (the script Coral wrote for this session's launch; "" when unknown, which recognises nothing), and whose only child is the
// recognised launcher cmd. It is then not a shell on the way either.
func programsBelowRule(src procSource, root int, cli, handoff string) (progs []winProc, unknown string, deep bool) {
	type node struct {
		pid, depth int
		start      int64
		under      string
		via        string
		handoff    bool // Coral's handoff PowerShell: its only child may be the launcher cmd
		launcher   bool // on the way here the recognised launcher cmd was passed
	}
	rootInfo := src.info(root)
	seen := map[int]bool{root: true}
	queue := []node{{root, 0, rootInfo.start, "", "", false, false}}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		kids := src.children(n.pid)
		siblingPrograms := 0 // programs among this node's children: a launcher cmd must have none beside it
		if (n.depth == 0 || n.handoff) && (cli != "" || handoff != "") {
			for _, k := range kids {
				if kp := src.info(k); kp.known && kp.kind == kindProgram {
					siblingPrograms++
				}
			}
		}
		for _, c := range kids {
			if seen[c] {
				continue
			}
			seen[c] = true
			p := src.info(c)
			if p.known && p.start < n.start {
				continue // an earlier owner's process: this pid was reused
			}
			if p.kind == kindConsoleHost {
				continue
			}
			if n.depth+1 >= maxWinWalkDepth {
				deep = true
				continue
			}
			switch {
			case p.kind == kindVerifiedShell && p.known:
				via, isHandoff, isLauncher := n.via, false, n.launcher
				if via == "" {
					via = p.name
					switch {
					case (n.depth == 0 || n.handoff) && cli != "" && p.name == "cmd" && siblingPrograms == 0:
						if line, ok := src.commandLine(c); ok && isLauncherCommandLine(line, cli) {
							via, isLauncher = "", true // Coral's launcher for the resolved CLI: not a shell a person started
							if !hasProgramChild(src, c) {
								// A .bat or .cmd that IS the resolved CLI and stays alive with nothing started below it (it blocks in a builtin): the cmd is the agent itself, not a shell with
								// nothing under it (#408). One that starts a program keeps the rule above: that program is the CLI's own.
								p.via, p.launched = "", true
								progs = append(progs, p)
								continue
							}
						}
					case n.depth == 0 && handoff != "" && cli != "" && (p.name == "powershell" || p.name == "pwsh") && siblingPrograms == 0:
						if line, ok := src.commandLine(c); ok && isHandoffCommandLine(line, handoff) && onlyChildIsLauncher(src, c, cli) {
							via, isHandoff = "", true // Coral's handoff script for this launch: not a shell a person started
						}
					}
				}
				queue = append(queue, node{c, n.depth + 1, p.start, n.under, via, isHandoff, isLauncher})
			case p.kind == kindUnknownShell && p.known:
				if unknown == "" {
					unknown = "a shell of unknown contents"
				}
				under := n.under
				if under == "" {
					under = "unknown"
				}
				queue = append(queue, node{c, n.depth + 1, p.start, under, n.via, false, false})
			case n.under != "":
				// a program under a shell of unknown contents is that shell's
			default:
				p.via, p.launched = n.via, n.launcher && n.via == ""
				progs = append(progs, p)
			}
		}
	}
	return progs, unknown, deep
}

// hasProgramChild is whether pid has a child that is not a console host (conhost.exe, OpenConsole): a program, a shell of any kind, or one the system could not describe.
func hasProgramChild(src procSource, pid int) bool {
	for _, k := range src.children(pid) {
		if src.info(k).kind != kindConsoleHost {
			return true
		}
	}
	return false
}

// winAgent is what Coral recorded of a session's agent process: its pid and creation time.
type winAgent struct {
	mu       sync.Mutex
	proc     winProc
	adopted  bool
	adopting bool
	gen      int
	stop     context.CancelFunc // ends the watch of the current launch
	handoff  string             // the coral-command-*.ps1 Coral wrote for the current launch ("" for a line typed as it is, or unknown)
	cli      string             // the CLI path Coral launched this session with ("" when unknown): the launcher cmd is compared with it, not with today's setting
}

// noteLaunch keeps what Coral launched the session with: the handoff script (or "") and the resolved CLI path.
func (a *winAgent) noteLaunch(script, cli string) {
	a.mu.Lock()
	a.handoff, a.cli = script, cli
	a.mu.Unlock()
}

// launchCLI is the CLI path the session was launched with. "" when none was kept: then nothing matches the launcher cmd and the agent needs the button. It is never today's setting: a
// cli_path changed after the launch must neither flip a running agent to nested nor make a different program look like its launcher.
func (a *winAgent) launchCLI() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cli
}

func (a *winAgent) handoffPath() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.handoff
}

// winWatches counts the running watches and winWatchStops holds their cancels, so StopWinAgentWatches (tests, shutdown) can end them and wait.
var (
	winWatches    sync.WaitGroup
	winWatchStopM sync.Mutex
	winWatchStops = map[*winAgent]context.CancelFunc{}
)

// StopWinAgentWatches ends every running watch for an agent's process and waits for them: the watches are bounded but outlive the test or the server that started them.
func StopWinAgentWatches() {
	winWatchStopM.Lock()
	for _, cancel := range winWatchStops {
		cancel()
	}
	winWatchStopM.Unlock()
	winWatches.Wait()
}

// reset forgets the record and starts a new generation: a watch of an older launch ends. The returned context ends with the next reset, stopWatch, or StopWinAgentWatches.
func (a *winAgent) reset() (int, context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stop != nil {
		a.stop()
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.stop = cancel
	winWatchStopM.Lock()
	winWatchStops[a] = cancel
	winWatchStopM.Unlock()
	a.gen++
	a.proc, a.adopted, a.adopting = winProc{}, false, true
	return a.gen, ctx
}

// stopWatch ends the watch of the current launch (the session ended).
func (a *winAgent) stopWatch() {
	a.mu.Lock()
	if a.stop != nil {
		a.stop()
		a.stop = nil
	}
	a.mu.Unlock()
	winWatchStopM.Lock()
	delete(winWatchStops, a)
	winWatchStopM.Unlock()
}

func (a *winAgent) snapshot() (rec winProc, adopted, adopting bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.proc, a.adopted, a.adopting
}

// adoptSingle is the one program to record, or false when there is none or more than one.
func adoptSingle(src procSource, root int) (winProc, bool) {
	progs, unknown, deep := programsBelow(src, root)
	if unknown != "" || deep || len(progs) != 1 {
		return winProc{}, false
	}
	return progs[0], true
}

// decideWinNotice is whether a notice may be typed given the recorded process: it is alive (same pid, same creation time), nothing under a shell of unknown contents is, and it is the only
// program below the terminal's root. Anything else (a nested shell's program, a hand-started CLI, a recycled pid) is not typed.
func decideWinNotice(src procSource, root int, rec winProc) tmux.NoticeVerdict {
	cur := src.info(rec.pid)
	if !cur.known || cur.start != rec.start {
		return tmux.NoticeVerdict{Reason: tmux.ReasonGone}
	}
	progs, unknown, deep := programsBelow(src, root)
	if unknown != "" || deep {
		return tmux.NoticeVerdict{Reason: tmux.ReasonForeground}
	}
	if len(progs) == 0 {
		return tmux.NoticeVerdict{Reason: tmux.ReasonBackground}
	}
	for _, p := range progs {
		if p.pid != rec.pid || p.start != rec.start {
			return tmux.NoticeVerdict{Reason: tmux.ReasonForeground}
		}
	}
	return tmux.NoticeVerdict{OK: true}
}

// winNoticeVerdict is the whole answer for a session: waiting while the record is being made, nothing recorded, or decideWinNotice.
func (a *winAgent) verdict(src procSource, root int) tmux.NoticeVerdict {
	rec, adopted, adopting := a.snapshot()
	switch {
	case adopting:
		return tmux.NoticeVerdict{Wait: true, Reason: tmux.ReasonAdopting}
	case !adopted:
		return tmux.NoticeVerdict{Reason: tmux.ReasonNotRecorded}
	}
	return decideWinNotice(src, root, rec)
}

// adoptTiming are the windows of the adoption, as on Unix (tmux/agentproc.go); a test passes its own.
type adoptTiming struct{ window, every, stable time.Duration }

var defaultAdoptTiming = adoptTiming{window: 20 * time.Second, every: 200 * time.Millisecond, stable: 600 * time.Millisecond}

// watch records the one program that appears below root and stays winAdoptStable, within winAdoptWindow. src and root are read afresh each poll (srcFor); generation gen ends it when a newer
// launch resets the record. done is told what happened (for the log).
func (a *winAgent) watch(ctx context.Context, gen int, tm adoptTiming, srcFor func() (procSource, int, bool), done func(p winProc, got bool)) {
	var last winProc
	var since time.Time
	for deadline := time.Now().Add(tm.window); time.Now().Before(deadline); {
		select {
		case <-ctx.Done():
			return // a newer launch, the session ended, or StopWinAgentWatches
		case <-time.After(tm.every):
		}
		a.mu.Lock()
		current := a.gen == gen
		a.mu.Unlock()
		if !current {
			return
		}
		src, root, ok := srcFor()
		if !ok {
			return // the session is gone
		}
		cand, one := adoptSingle(src, root)
		if !one {
			last, since = winProc{}, time.Time{}
			continue
		}
		if cand != last {
			last, since = cand, time.Now()
			continue
		}
		if time.Since(since) >= tm.stable {
			a.mu.Lock()
			if a.gen == gen {
				a.proc, a.adopted, a.adopting = cand, true, false
			}
			a.mu.Unlock()
			done(cand, true)
			return
		}
	}
	a.mu.Lock()
	if a.gen == gen {
		a.adopting = false
	}
	a.mu.Unlock()
	done(winProc{}, false)
}

// "Record as agent" (#391) on Windows: the single program below the terminal's root, and recording it when it is still the one the Operator was shown.

// candidateWin is the single program below root (through verified shells), or why there is none.
func candidateWin(src procSource, root int) (winProc, string) { return candidateWinCLI(src, root, "") }

// candidateWinCLI is candidateWin with the session's resolved CLI path, for the launcher rule.
func candidateWinCLI(src procSource, root int, cli string) (winProc, string) {
	return candidateWinRule(src, root, cli, "")
}

// candidateWinRule is candidateWinCLI with the handoff script Coral wrote for the session's launch ("" when unknown).
func candidateWinRule(src procSource, root int, cli, handoff string) (winProc, string) {
	progs, unknown, deep := programsBelowRule(src, root, cli, handoff)
	switch {
	case unknown != "":
		return winProc{}, "a shell of unknown contents (git-bash, WSL) is in the terminal: what runs in it can't be seen"
	case deep:
		return winProc{}, "the terminal's shells are nested too deep to read"
	case len(progs) == 0:
		return winProc{}, "no program is running in the terminal"
	case len(progs) > 1:
		return winProc{}, "several programs are running in the terminal"
	}
	return progs[0], ""
}

// recordWin records want as the agent when it is still exactly the one program (same pid, same creation time). wantStart is the creation time as the dashboard was given it.
func (a *winAgent) recordWin(src procSource, root int, want winProc, cli string) (winProc, error) {
	got, why := candidateWinRule(src, root, a.launchCLI(), a.handoffPath())
	if why != "" {
		return winProc{}, ErrNoCandidate
	}
	if got.pid != want.pid || got.start != want.start || want.pid <= 0 {
		return winProc{}, ErrCandidateChanged
	}
	if (got.via != "" || got.name == "") && !want.acknowledged { // checked in this read, the one that checks pid and start; no image name = the program cannot be told from anything
		return winProc{}, &NeedsAcknowledgementError{Under: got.via, Unidentified: got.name == ""}
	}
	a.mu.Lock()
	a.gen++ // a watch for an older launch ends
	if a.stop != nil {
		a.stop()
		a.stop = nil
	}
	a.proc, a.adopted, a.adopting = got, true, false
	a.mu.Unlock()
	return got, nil
}

// winCandidateFields is the candidate's pid, start and the shell on the way; the Windows glue adds the image path and program name.
func winCandidateFields(c winProc) AgentCandidate {
	return AgentCandidate{PID: c.pid, Start: strconv.FormatInt(c.start, 10), Under: c.via, Launched: c.launched}
}
