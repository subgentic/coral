package ptymanager

import (
	"context"

	"github.com/subgentic/coral/internal/tmux"
)

// "Record as agent" (#391). Where a terminal can tell which single program is in its foreground, the Operator can record it as the session's agent after an update (an agent already
// running then has no record, so its board notices are paused). The request carries the pid and start time the Operator was shown, so a program that changed in between is refused.

// AgentCandidate is the one foreground program of an agent's terminal: its pid, ps start time, name, and (where it can be read) the path of its image.
type AgentCandidate struct {
	PID     int    `json:"pid"`
	Start   string `json:"start"`
	Program string `json:"program"`
	// Under is the nested shell the program runs inside ("" for a direct child of the terminal's shell). Recording such a program needs the Operator's explicit acknowledgement.
	Under string `json:"under"`
	Image string `json:"-"`
}

// ErrCandidateChanged and ErrNoCandidate are tmux's: the foreground program is not the one shown / there is not exactly one.
var (
	ErrCandidateChanged = tmux.ErrCandidateChanged
	ErrNoCandidate      = tmux.ErrNoCandidate
)

// AgentRecorder is implemented by terminals that can name and record an agent's single foreground program (tmux, the PTY backend).
type AgentRecorder interface {
	// AgentCandidate: the single foreground program, or why not (why is "" when there is one).
	AgentCandidate(ctx context.Context, name, agentType, sessionID string) (cand AgentCandidate, why string, err error)
	// RecordAgent records want when it is still exactly the one foreground program; ErrCandidateChanged / ErrNoCandidate otherwise.
	RecordAgent(ctx context.Context, name, agentType, sessionID string, want AgentCandidate) (AgentCandidate, error)
}

func fromTmux(c tmux.Candidate) AgentCandidate {
	return AgentCandidate{PID: c.PID, Start: c.Start, Program: c.Program, Under: c.Under, Image: tmux.ProgramImage(c.PID)}
}

// AgentCandidate implements AgentRecorder for tmux.
func (t *TmuxSessionTerminal) AgentCandidate(ctx context.Context, name, agentType, sessionID string) (AgentCandidate, string, error) {
	c, why, err := t.client.AgentCandidate(ctx, name, agentType, sessionID)
	if err != nil || why != "" {
		return AgentCandidate{}, why, err
	}
	return fromTmux(c), "", nil
}

// RecordAgent implements AgentRecorder for tmux.
func (t *TmuxSessionTerminal) RecordAgent(ctx context.Context, name, agentType, sessionID string, want AgentCandidate) (AgentCandidate, error) {
	c, err := t.client.RecordAgent(ctx, name, agentType, sessionID, tmux.AgentProc{PID: want.PID, Start: want.Start})
	if err != nil {
		return AgentCandidate{}, err
	}
	return fromTmux(c), nil
}

// AgentCandidate implements AgentRecorder for the PTY backend.
func (p *PTYSessionTerminal) AgentCandidate(_ context.Context, name, _, sessionID string) (AgentCandidate, string, error) {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return AgentCandidate{}, "", err
	}
	return p.backend.AgentCandidate(key)
}

// RecordAgent implements AgentRecorder for the PTY backend.
func (p *PTYSessionTerminal) RecordAgent(_ context.Context, name, _, sessionID string, want AgentCandidate) (AgentCandidate, error) {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return AgentCandidate{}, err
	}
	return p.backend.RecordAgent(key, want)
}

// agentRecordProc is implemented by pseudo-terminals that name and record the agent themselves (Windows ConPTY); a Unix pseudo-terminal names its shell pid (shellPIDReporter).
type agentRecordProc interface {
	AgentCandidate() (cand AgentCandidate, why string, err error)
	RecordAgent(want AgentCandidate) (AgentCandidate, error)
}

// AgentCandidate is the single foreground program of a session's terminal. A gone session or a backend that cannot say is ErrTerminalGone / ErrNoCandidate.
func (m *PTYBackend) AgentCandidate(name string) (AgentCandidate, string, error) {
	m.mu.RLock()
	s, found := m.sessions[name]
	m.mu.RUnlock()
	if !found || !s.isRunning() {
		return AgentCandidate{}, "", ErrTerminalGone
	}
	if r, can := s.proc.(agentRecordProc); can {
		return r.AgentCandidate()
	}
	sp, can := s.proc.(shellPIDReporter)
	if !can {
		return AgentCandidate{}, "this terminal cannot say which program is in its foreground", nil
	}
	c, why, err := tmux.CandidateForShell(sp.ShellPID())
	if err != nil || why != "" {
		return AgentCandidate{}, why, err
	}
	return fromTmux(c), "", nil
}

// RecordAgent records want as a session's agent process, when it is still exactly the one foreground program.
func (m *PTYBackend) RecordAgent(name string, want AgentCandidate) (AgentCandidate, error) {
	m.mu.RLock()
	s, found := m.sessions[name]
	m.mu.RUnlock()
	if !found || !s.isRunning() {
		return AgentCandidate{}, ErrTerminalGone
	}
	if r, can := s.proc.(agentRecordProc); can {
		return r.RecordAgent(want)
	}
	sp, can := s.proc.(shellPIDReporter)
	if !can {
		return AgentCandidate{}, ErrNoCandidate
	}
	c, err := tmux.RecordAgentForShell(name, sp.ShellPID(), tmux.AgentProc{PID: want.PID, Start: want.Start})
	if err != nil {
		return AgentCandidate{}, err
	}
	return fromTmux(c), nil
}

// NoticeState is whether a notice would be typed into the agent's terminal now, without logging or recording anything: ok, wait (the record is being made), the reason when not ok, and
// known=false when the terminal cannot say. It is the dashboard's and the "record as agent" routes' read of the same check NoticeBlocked makes.
func NoticeState(ctx context.Context, term any, name, agentType, sessionID string) (ok, wait bool, why string, known bool) {
	c, can := term.(NoticeTargetChecker)
	if !can {
		return false, false, "", false
	}
	return c.AgentNoticeTarget(ctx, name, agentType, sessionID)
}
