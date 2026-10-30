package tmux

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// The session's recorded agent process (#389). Board notices are typed into an agent's terminal, and a terminal whose foreground is anything else (a shell a person started, a
// program in it, a CLI started by hand) would take them as input of its own, or run them as commands once the program ends. So a notice is typed only while the process Coral
// recorded as the session's agent CLI, by pid AND start time, is alive and is the foreground program of the pane's shell.
//
// Adoption: when Coral types a launch line (launch, wake, resume) it watches the pane's shell for a bounded window; the one foreground non-shell program that appears and stays
// (the launch script's own short-lived commands do not stay) is recorded. None, or more than one, adopts nothing. The record is also kept in the tmux session (the user option
// @coral_agent, "<pid> <start>"), which outlives a Coral restart: after a restart the exact process is re-checked (alive, same start time), never guessed from what the pane runs now.
// A CLI that is replaced by a new process (not an exec, which keeps the pid) is not recorded again: notices stay paused, visibly, until a Wake. Nothing is read from a process's
// environment: Coral's launch line exports CORAL_SESSION_NAME into the pane's shell, so every later program there carries it and it proves nothing.

// AgentProc names one process for good: its pid and the start time ps reports for it (a recycled pid has another).
type AgentProc struct {
	PID   int
	Start string
}

// Windows of the adoption.
var (
	adoptWindow = 20 * time.Second       // how long after a launch line the pane is watched
	adoptEvery  = 200 * time.Millisecond // how often
	adoptStable = 600 * time.Millisecond // the same single program must be there this long: the launch script's own commands (clear, printf) are gone by then
)

type agentRec struct {
	proc     AgentProc
	adopted  bool
	adopting bool
	launchAt time.Time          // when the session was created for a launch whose line is not typed yet (zero once the watch has begun)
	gen      int                // a newer launch line supersedes the watch of an older one
	stop     context.CancelFunc // ends the watch of this launch
}

// watches counts the running watches, so StopAgentWatches (tests, shutdown) can end them and wait.
var watches sync.WaitGroup

// StopAgentWatches ends every running watch for an agent's process and waits for them: the watches are bounded (adoptWindow) but outlive the test or the server that started them.
func StopAgentWatches() {
	agentRecs.Lock()
	for _, r := range agentRecs.m {
		if r.stop != nil {
			r.stop()
		}
	}
	agentRecs.Unlock()
	watches.Wait()
}

var agentRecs = struct {
	sync.Mutex
	m map[string]*agentRec
}{m: map[string]*agentRec{}}

// ForgetAgentProc drops what Coral recorded of a session's agent process (the session ended, or a new launch line is about to be typed).
func ForgetAgentProc(session string) {
	agentRecs.Lock()
	defer agentRecs.Unlock()
	if r, ok := agentRecs.m[session]; ok {
		r.gen++ // a watch of the old launch sees it changed and ends
		r.proc, r.adopted, r.adopting = AgentProc{}, false, false
		r.launchAt = time.Time{}
		if r.stop != nil {
			r.stop()
			r.stop = nil
		}
	}
}

// launchGrace is how long after a session is created for a launch its notices are told to wait, not refused, while the launch line is not typed yet (the launch call returns before it is, and a task
// created right after it would otherwise be dropped, #137855). A launch whose line is never typed stops being waited for after this.
var launchGrace = 15 * time.Second

// NoteLaunching records that session was just created for an agent launch: until its launch line is typed and the watch begins (AdoptAgentAfterLaunch), a notice for it gets the "wait" verdict. Nothing is
// ever typed on this: it only turns "not recorded" into "not recorded yet" for launchGrace.
func NoteLaunching(session string) {
	agentRecs.Lock()
	defer agentRecs.Unlock()
	r := agentRecs.m[session]
	if r == nil {
		r = &agentRec{}
		agentRecs.m[session] = r
	}
	if !r.adopting && !r.adopted {
		r.launchAt = time.Now()
	}
}

// AdoptedAgentProc is the recorded process of a session, for tests and the log.
func AdoptedAgentProc(session string) (AgentProc, bool) {
	agentRecs.Lock()
	defer agentRecs.Unlock()
	if r, ok := agentRecs.m[session]; ok && r.adopted {
		return r.proc, true
	}
	return AgentProc{}, false
}

// AdoptAgentAfterLaunch starts the watch of a pane after a launch line was typed into it: the session's agent process is recorded when it appears. target is the pane (session or
// session.pane); session is the key the notices are checked by.
func (c *Client) AdoptAgentAfterLaunch(session, target string) {
	c.run(context.Background(), "set-option", "-u", "-t", session, agentOption) // a new launch: what was kept of the old process is not true of the new one
	adoptAfterLaunch(session, func(ctx context.Context) (int, error) {
		out, err := c.DisplayMessage(ctx, target, "#{pane_pid}")
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(strings.TrimSpace(out))
	}, func(ctx context.Context, p AgentProc) { c.persistAgentProc(ctx, session, p) })
}

// AdoptAgentForShell is AdoptAgentAfterLaunch for a pseudo-terminal whose shell pid is known (the Unix PTY backend): there is no tmux session to keep the record in, and a Coral restart ends
// the pseudo-terminal's sessions anyway.
func AdoptAgentForShell(session string, shell int) {
	adoptAfterLaunch(session, func(context.Context) (int, error) { return shell, nil }, nil)
}

// NoticeVerdictForShell is the verdict for a pseudo-terminal whose shell pid is known, from the record in memory only.
func NoticeVerdictForShell(session string, shell int) (NoticeVerdict, error) {
	procs, err := readProcTable()
	if err != nil {
		return NoticeVerdict{}, fmt.Errorf("read process table: %w", err)
	}
	return noticeVerdict(procs, shell, session, nil), nil
}

func adoptAfterLaunch(session string, findShell func(context.Context) (int, error), persist func(context.Context, AgentProc)) {
	agentRecs.Lock()
	r := agentRecs.m[session]
	if r == nil {
		r = &agentRec{}
		agentRecs.m[session] = r
	}
	r.gen++
	gen := r.gen
	if r.stop != nil {
		r.stop() // the watch of an older launch ends
	}
	ctx, cancel := context.WithTimeout(context.Background(), adoptWindow+10*time.Second)
	r.stop = cancel
	r.adopted, r.proc, r.adopting = false, AgentProc{}, true
	r.launchAt = time.Time{} // the watch itself says the process is on its way
	watches.Add(1)
	agentRecs.Unlock()
	safego.Go("tmux-adopt-agent", func() { defer watches.Done(); defer cancel(); watchForAgent(ctx, session, findShell, persist, gen) })
}

// agentOption is the tmux session option the recorded process is kept in, "<pid> <start>".
//
// It is NOT authentication. A program inside the pane (or anything the same user runs) can set it, as it can type into the pane itself. What it can do is name one process, and that
// only matters when the process is the pane's current foreground program: the check (decideNotice) compares the named pid and start time with what the pane runs now, so naming
// another program of the pane makes Coral type notices into a program that is already in the pane's foreground, which gains nothing over typing into it. It cannot make Coral type
// into another pane, and it cannot make a hand-started program an agent unless that program is the pane's only foreground program at that moment.
const agentOption = "@coral_agent"

func (c *Client) persistAgentProc(ctx context.Context, session string, p AgentProc) {
	if _, err := c.run(ctx, "set-option", "-t", session, agentOption, strconv.Itoa(p.PID)+" "+p.Start); err != nil {
		slog.Warn("could not keep the agent's process in the tmux session: after a Coral restart notices stay paused until a Wake", "session", session, "error", err)
	}
}

// loadAgentProc is the process kept in the tmux session by persistAgentProc, if any.
func (c *Client) loadAgentProc(ctx context.Context, agentName, agentType, sessionID string) (AgentProc, bool) {
	out, err := c.DisplayForAgent(ctx, agentName, agentType, sessionID, "#{"+agentOption+"}")
	if err != nil {
		return AgentProc{}, false
	}
	pidText, start, ok := strings.Cut(strings.TrimSpace(out), " ")
	pid, perr := strconv.Atoi(pidText)
	if !ok || perr != nil || pid <= 0 || start == "" {
		return AgentProc{}, false
	}
	return AgentProc{PID: pid, Start: start}, true
}

func watchForAgent(ctx context.Context, session string, findShell func(context.Context) (int, error), persist func(context.Context, AgentProc), gen int) {
	finish := func(p AgentProc, got bool, why string) {
		agentRecs.Lock()
		r := agentRecs.m[session]
		if r == nil || r.gen != gen {
			agentRecs.Unlock()
			return // a newer launch line, or the session ended
		}
		r.adopting = false
		if got {
			r.proc, r.adopted = p, true
		}
		agentRecs.Unlock()
		if got {
			slog.Info("recorded the agent's process", "session", session, "pid", p.PID, "start", p.Start)
			if persist != nil {
				persist(ctx, p) // outside the lock: it runs tmux
			}
		} else {
			slog.Warn("did not record the agent's process: board notices stay off until it is recorded (Wake it, or restart the agent)", "session", session, "why", why)
		}
	}
	var shell int
	var last AgentProc
	var since time.Time
	for deadline := time.Now().Add(adoptWindow); time.Now().Before(deadline); {
		select {
		case <-ctx.Done():
			return // StopAgentWatches, a newer launch, or the session ended
		case <-time.After(adoptEvery):
		}
		agentRecs.Lock()
		r := agentRecs.m[session]
		current := r != nil && r.gen == gen
		agentRecs.Unlock()
		if !current {
			return
		}
		if shell == 0 {
			var err error
			if shell, err = findShell(ctx); err != nil {
				shell = 0
				if ctx.Err() != nil {
					return
				}
				return // the pane is gone, or its pid is not a number
			}
		}
		procs, err := readProcTableMaxAge(100 * time.Millisecond)
		if err != nil {
			continue
		}
		cand, ok := adoptCandidate(procs, shell)
		if !ok {
			last, since = AgentProc{}, time.Time{} // none yet, or more than one: nothing to adopt
			continue
		}
		if cand != last {
			last, since = cand, time.Now()
			continue
		}
		if time.Since(since) >= adoptStable {
			finish(cand, true, "")
			return
		}
	}
	finish(AgentProc{}, false, "no single foreground program stayed in the pane for "+adoptStable.String())
}

// nestedShellWalk bounds the walks below a pane's shell.
const nestedShellWalk = nestedShellDepth

// fgProg is a foreground program below the pane's shell and the shell it runs inside: under is the name of the first shell on the way ("" for a direct child of the pane's shell).
type fgProg struct {
	pid   int
	under string
}

// programsBelowUnder lists the foreground programs (a '+' in ps state, not shells) below the pane's shell, walking through the shells in between: the top ones, not their own children
// (an agent's tools run in its foreground group too, and are its). deep is true when the walk hit its depth bound.
func programsBelowUnder(t *procTable, shell int) (progs []fgProg, deep bool) {
	seen := map[int]bool{}
	var walk func(pid, depth int, under string)
	walk = func(pid, depth int, under string) {
		if seen[pid] {
			return
		}
		seen[pid] = true
		if depth > nestedShellWalk {
			deep = true
			return
		}
		for _, c := range t.children[pid] {
			e := t.byPID[c]
			if IsShellCommand(e.comm) {
				u := under
				if u == "" {
					u = ProgramBase(e.comm)
				}
				walk(c, depth+1, u)
			} else if strings.Contains(e.stat, "+") {
				progs = append(progs, fgProg{c, under})
			}
		}
	}
	walk(shell, 0, "")
	return progs, deep
}

// programsBelow is programsBelowUnder's pids.
func programsBelow(t *procTable, shell int) (progs []int, deep bool) {
	list, deep := programsBelowUnder(t, shell)
	for _, p := range list {
		progs = append(progs, p.pid)
	}
	return progs, deep
}

// adoptCandidate is the one foreground program below the pane's shell, or false when there is none or more than one (nothing is adopted then).
func adoptCandidate(t *procTable, shell int) (AgentProc, bool) {
	progs, deep := programsBelow(t, shell)
	if deep || len(progs) != 1 {
		return AgentProc{}, false
	}
	return AgentProc{PID: progs[0], Start: t.byPID[progs[0]].start}, true
}

// decideNotice is whether a notice may be typed given the recorded process: it is alive (same pid, same start time) and it is the only foreground program of the pane.
func decideNotice(t *procTable, shell int, rec AgentProc) NoticeVerdict {
	e, ok := t.byPID[rec.PID]
	if !ok || e.start != rec.Start {
		return NoticeVerdict{Reason: ReasonGone}
	}
	progs, deep := programsBelow(t, shell)
	if deep {
		return NoticeVerdict{Reason: ReasonForeground}
	}
	if len(progs) == 0 {
		return NoticeVerdict{Reason: ReasonBackground}
	}
	for _, p := range progs {
		if p != rec.PID {
			return NoticeVerdict{Reason: ReasonForeground}
		}
	}
	return NoticeVerdict{OK: true}
}

// AgentNoticeVerdict says whether a board notice may be typed into the agent's pane now. It returns ErrTerminalGone when the pane is gone.
func (c *Client) AgentNoticeVerdict(ctx context.Context, agentName, agentType, sessionID string) (NoticeVerdict, error) {
	shell, err := c.agentShellPID(ctx, agentName, agentType, sessionID)
	if err != nil {
		return NoticeVerdict{}, err
	}
	procs, err := readProcTable()
	if err != nil {
		return NoticeVerdict{}, fmt.Errorf("read process table: %w", err)
	}
	return noticeVerdict(procs, shell, agentName, func() (AgentProc, bool) { return c.loadAgentProc(ctx, agentName, agentType, sessionID) }), nil
}

// noticeVerdict is the answer for a session. load reads the process kept in the tmux session (nil: none): used when Coral has nothing in memory (it restarted), to re-check that exact process.
func noticeVerdict(procs *procTable, shell int, session string, load func() (AgentProc, bool)) NoticeVerdict {
	agentRecs.Lock()
	r := agentRecs.m[session]
	var rec AgentProc
	adopted, adopting, launching := false, false, false
	if r != nil {
		rec, adopted, adopting = r.proc, r.adopted, r.adopting
		launching = !r.launchAt.IsZero() && time.Since(r.launchAt) < launchGrace
	}
	agentRecs.Unlock()
	if adopting || (launching && !adopted) {
		return NoticeVerdict{Wait: true, Reason: ReasonAdopting}
	}
	if adopted {
		v := decideNotice(procs, shell, rec)
		if v.OK || v.Reason != ReasonGone {
			return v
		}
	}
	if adopted { // the recorded process is gone (the CLI was replaced, or it exited): paused until a Wake records the new one
		return NoticeVerdict{Reason: ReasonGone}
	}
	// Nothing in memory (a Coral restart): the process kept in the tmux session is checked, that exact one, never guessed from what the pane runs now.
	if load != nil {
		if kept, ok := load(); ok {
			v := decideNotice(procs, shell, kept)
			if v.Reason != ReasonGone {
				agentRecs.Lock()
				if r := agentRecs.m[session]; r == nil || !r.adopting {
					if r == nil {
						r = &agentRec{}
						agentRecs.m[session] = r
					}
					r.proc, r.adopted = kept, true
				}
				agentRecs.Unlock()
				slog.Info("took up the agent's process kept in the tmux session", "session", session, "pid", kept.PID, "start", kept.Start)
			}
			return v
		}
	}
	return NoticeVerdict{Reason: ReasonNotRecorded}
}
