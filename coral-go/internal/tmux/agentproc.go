package tmux

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
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
// (the launch script's own short-lived commands do not stay) is recorded. None, or more than one, adopts nothing. After a Coral restart, or when the CLI replaced itself, the one
// place an image is read is readopt: the single foreground program must look like an agent CLI AND carry this session's CORAL_SESSION_NAME in its environment, which a CLI started by
// hand in the pane does not; where the environment cannot be read nothing is adopted.

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
	gen      int // a newer launch line supersedes the watch of an older one
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
	agentRecs.Lock()
	r := agentRecs.m[session]
	if r == nil {
		r = &agentRec{}
		agentRecs.m[session] = r
	}
	r.gen++
	gen := r.gen
	r.adopted, r.proc, r.adopting = false, AgentProc{}, true
	agentRecs.Unlock()
	safego.Go("tmux-adopt-agent", func() { c.watchForAgent(session, target, gen) })
}

func (c *Client) watchForAgent(session, target string, gen int) {
	ctx, cancel := context.WithTimeout(context.Background(), adoptWindow+10*time.Second)
	defer cancel()
	finish := func(p AgentProc, got bool, why string) {
		agentRecs.Lock()
		defer agentRecs.Unlock()
		r := agentRecs.m[session]
		if r == nil || r.gen != gen {
			return // a newer launch line, or the session ended
		}
		r.adopting = false
		if got {
			r.proc, r.adopted = p, true
			slog.Info("recorded the agent's process", "session", session, "pid", p.PID, "start", p.Start)
		} else {
			slog.Warn("did not record the agent's process: board notices stay off until it is recorded (Wake it, or restart the agent)", "session", session, "why", why)
		}
	}
	var shell int
	var last AgentProc
	var since time.Time
	for deadline := time.Now().Add(adoptWindow); time.Now().Before(deadline); time.Sleep(adoptEvery) {
		agentRecs.Lock()
		r := agentRecs.m[session]
		current := r != nil && r.gen == gen
		agentRecs.Unlock()
		if !current {
			return
		}
		if shell == 0 {
			out, err := c.DisplayMessage(ctx, target, "#{pane_pid}")
			if err != nil {
				return // the pane is gone
			}
			if shell, err = strconv.Atoi(strings.TrimSpace(out)); err != nil {
				shell = 0
				continue
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

// programsBelow lists the foreground programs (a '+' in ps state, not shells) below the pane's shell, walking through the shells in between: the top ones, not their own children
// (an agent's tools run in its foreground group too, and are its). deep is true when the walk hit its depth bound.
func programsBelow(t *procTable, shell int) (progs []int, deep bool) {
	seen := map[int]bool{}
	var walk func(pid, depth int)
	walk = func(pid, depth int) {
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
				walk(c, depth+1)
			} else if strings.Contains(e.stat, "+") {
				progs = append(progs, c)
			}
		}
	}
	walk(shell, 0)
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

// agentImages are the process names an agent CLI runs as: the CLIs themselves and the interpreters their npm shims run under. Only readopt reads it.
var agentImages = map[string]bool{
	"claude": true, "codex": true, "agy": true, "gemini": true, "pi": true,
	"node": true, "bun": true, "deno": true,
}

func looksLikeAgentImage(comm string) bool {
	n := strings.ToLower(strings.TrimSpace(comm))
	return agentImages[strings.TrimSuffix(filepath.Base(n), ".exe")]
}

// readopt records the pane's single foreground program as the session's agent when it looks like an agent CLI AND its environment carries this session's CORAL_SESSION_NAME. It is
// the only place an image is read (after a Coral restart, or when the CLI replaced itself). procEnvHasSession is false where the environment cannot be read.
func readopt(t *procTable, shell int, session string) (AgentProc, bool) {
	cand, ok := adoptCandidate(t, shell)
	if !ok {
		return AgentProc{}, false
	}
	if !looksLikeAgentImage(t.byPID[cand.PID].comm) || !procEnvCheck(cand.PID, session) {
		return AgentProc{}, false
	}
	return cand, true
}

// procEnvCheck is procEnvHasSession (a test seam).
var procEnvCheck = procEnvHasSession

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
	return noticeVerdict(procs, shell, agentName), nil
}

func noticeVerdict(procs *procTable, shell int, session string) NoticeVerdict {
	agentRecs.Lock()
	r := agentRecs.m[session]
	var rec AgentProc
	adopted, adopting := false, false
	if r != nil {
		rec, adopted, adopting = r.proc, r.adopted, r.adopting
	}
	agentRecs.Unlock()
	if adopting {
		return NoticeVerdict{Wait: true, Reason: ReasonAdopting}
	}
	if adopted {
		v := decideNotice(procs, shell, rec)
		if v.OK || v.Reason != ReasonGone {
			return v
		}
	}
	// Nothing recorded (a Coral restart), or the recorded process is gone (the CLI replaced itself): the environment evidence decides.
	if p, ok := readopt(procs, shell, session); ok {
		agentRecs.Lock()
		if r := agentRecs.m[session]; r == nil || !r.adopting {
			if r == nil {
				r = &agentRec{}
				agentRecs.m[session] = r
			}
			r.proc, r.adopted = p, true
		}
		agentRecs.Unlock()
		slog.Info("recorded the agent's process again", "session", session, "pid", p.PID, "start", p.Start)
		return decideNotice(procs, shell, p)
	}
	if adopted {
		return NoticeVerdict{Reason: ReasonGone}
	}
	return NoticeVerdict{Reason: ReasonNotRecorded}
}
