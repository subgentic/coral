package tmux

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// "Record as agent" (#391): an agent that was already running when Coral updated has no record, so its notices are paused (ReasonNotRecorded). The Operator can say that the one
// program in the foreground of its terminal IS the agent: the dashboard shows its pid and name, and the request carries the pid and start time that were shown, so a program that
// changed in between is refused and nothing is recorded. Anything but one foreground program is refused as well.

// Candidate is the one foreground program of an agent's terminal: what a "record as agent" would record.
type Candidate struct {
	AgentProc
	Program string // the process name ps reports (a path on macOS)
	// Under is the name of the nested shell the program runs inside ("" for a direct child of the pane's shell). A program under a nested shell is what the notice check exists to stop,
	// so recording it needs the Operator's explicit acknowledgement, and the bulk action never records it.
	Under string
}

// ErrCandidateChanged: the foreground program is not the one that was shown (it ended, another started, or there is not exactly one).
var ErrCandidateChanged = errors.New("the foreground program is no longer that process")

// ErrNoCandidate: there is no single foreground program to record.
// ErrNeedsAcknowledgement: the program runs inside a nested shell (Under != ""), and the request did not carry the Operator's acknowledgement. Checked in the record's own table read, the one that
// checks pid and start, so a program that moved under a nested shell since the Operator was shown it is refused (Security on #391).
var ErrNeedsAcknowledgement = errors.New("the program runs inside a nested shell and needs the Operator's acknowledgement")

// NeedsAcknowledgementError is ErrNeedsAcknowledgement with the nested shell's name.
type NeedsAcknowledgementError struct {
	Under        string
	Unidentified bool // the program's image could not be read
}

func (e *NeedsAcknowledgementError) Error() string {
	return ErrNeedsAcknowledgement.Error() + " (" + e.Under + ")"
}
func (e *NeedsAcknowledgementError) Is(target error) bool { return target == ErrNeedsAcknowledgement }

var ErrNoCandidate = errors.New("there is no single foreground program in the agent's terminal")

// candidateOf is the single foreground program below the pane's shell, or the reason there is none.
func candidateOf(t *procTable, shell int) (Candidate, string) {
	progs, deep := programsBelowUnder(t, shell)
	switch {
	case deep:
		return Candidate{}, "the terminal's shells are nested too deep to read"
	case len(progs) == 0:
		return Candidate{}, "nothing is in the foreground of the terminal"
	case len(progs) > 1:
		return Candidate{}, "several programs are in the foreground of the terminal"
	}
	e := t.byPID[progs[0].pid]
	return Candidate{AgentProc: AgentProc{PID: progs[0].pid, Start: e.start}, Program: e.comm, Under: progs[0].under}, ""
}

// recordCandidate records want as the session's agent when it is still exactly the one foreground program.
func recordCandidate(t *procTable, shell int, session string, want AgentProc, acknowledged, imageKnown bool) (Candidate, error) {
	got, why := candidateOf(t, shell)
	if why != "" {
		return Candidate{}, fmt.Errorf("%w: %s", ErrNoCandidate, why)
	}
	if got.AgentProc != want || want.PID <= 0 || want.Start == "" {
		return Candidate{}, ErrCandidateChanged
	}
	if (got.Under != "" || !imageKnown) && !acknowledged { // a nested shell's program, or one whose image cannot be read (it cannot be told from anything)
		return Candidate{}, &NeedsAcknowledgementError{Under: got.Under, Unidentified: !imageKnown}
	}
	agentRecs.Lock()
	r := agentRecs.m[session]
	if r == nil {
		r = &agentRec{}
		agentRecs.m[session] = r
	}
	r.gen++ // a watch for an older launch ends
	if r.stop != nil {
		r.stop()
		r.stop = nil
	}
	r.proc, r.adopted, r.adopting = got.AgentProc, true, false
	agentRecs.Unlock()
	return got, nil
}

// AgentCandidate is the one foreground program of the agent's pane (why says why not, when there is not exactly one).
func (c *Client) AgentCandidate(ctx context.Context, agentName, agentType, sessionID string) (Candidate, string, error) {
	shell, err := c.agentShellPID(ctx, agentName, agentType, sessionID)
	if err != nil {
		return Candidate{}, "", err
	}
	procs, err := readProcTableFresh()
	if err != nil {
		return Candidate{}, "", fmt.Errorf("read process table: %w", err)
	}
	cand, why := candidateOf(procs, shell)
	return cand, why, nil
}

// RecordAgent records want as the pane's agent process, in memory and in the tmux session (so a Coral restart re-checks it).
func (c *Client) RecordAgent(ctx context.Context, agentName, agentType, sessionID string, want AgentProc, acknowledged bool) (Candidate, error) {
	shell, err := c.agentShellPID(ctx, agentName, agentType, sessionID)
	if err != nil {
		return Candidate{}, err
	}
	procs, err := readProcTableFresh()
	if err != nil {
		return Candidate{}, fmt.Errorf("read process table: %w", err)
	}
	got, err := recordCandidate(procs, shell, agentName, want, acknowledged, ProgramImage(want.PID) != "")
	if err != nil {
		return Candidate{}, err
	}
	c.persistAgentProc(ctx, agentName, got.AgentProc)
	slog.Info("recorded the agent's process by the Operator's request", "session", agentName, "pid", got.PID, "program", got.Program)
	return got, nil
}

// CandidateForShell and RecordAgentForShell are the same for a pseudo-terminal whose shell pid is known (the Unix PTY backend): nothing is kept beyond memory.
func CandidateForShell(shell int) (Candidate, string, error) {
	procs, err := readProcTableFresh()
	if err != nil {
		return Candidate{}, "", fmt.Errorf("read process table: %w", err)
	}
	cand, why := candidateOf(procs, shell)
	return cand, why, nil
}

func RecordAgentForShell(session string, shell int, want AgentProc, acknowledged bool) (Candidate, error) {
	procs, err := readProcTableFresh()
	if err != nil {
		return Candidate{}, fmt.Errorf("read process table: %w", err)
	}
	got, err := recordCandidate(procs, shell, session, want, acknowledged, ProgramImage(want.PID) != "")
	if err == nil {
		slog.Info("recorded the agent's process by the Operator's request", "session", session, "pid", got.PID, "program", got.Program)
	}
	return got, err
}

// ProgramBase is a program name without its directory (macOS ps reports a path).
func ProgramBase(program string) string {
	p := strings.TrimSpace(program)
	if i := strings.LastIndexAny(p, "/"+"\\"); i >= 0 {
		p = p[i+1:]
	}
	return p
}
