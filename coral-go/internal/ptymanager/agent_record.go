package ptymanager

import (
	"context"
	"fmt"
	"path"
	"strings"

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
	// Script is the absolute script path of `interpreter script ...` (see ScriptIsCLI): only for the bulk match, never shown, logged or kept.
	Script string `json:"-"`
	// AcknowledgeNested, on a candidate passed to RecordAgent, is the Operator's "I know this is the agent, not something I started by hand" for a program under a nested shell.
	AcknowledgeNested bool   `json:"-"`
	Image             string `json:"-"`
	// Folder is the image's folder, cleaned and capped (visibleName), shown next to Program so the Operator sees WHERE the program is from. Unidentified: the image could not be read; Program then says so, recording needs the acknowledgement, and bulk leaves it.
	Folder       string `json:"folder"`
	Unidentified bool   `json:"unidentified"`
	// CLIPath, on a candidate passed to RecordAgent, is the session's resolved CLI path (see AgentRecorder.AgentCandidate).
	CLIPath string `json:"-"`
}

// ErrCandidateChanged and ErrNoCandidate are tmux's: the foreground program is not the one shown / there is not exactly one.
var (
	ErrCandidateChanged = tmux.ErrCandidateChanged
	ErrNoCandidate      = tmux.ErrNoCandidate
	// ErrNeedsAcknowledgement: a program under a nested shell, recorded without the Operator's acknowledgement (the check is part of the record itself).
	ErrNeedsAcknowledgement = tmux.ErrNeedsAcknowledgement
)

// NeedsAcknowledgementError is ErrNeedsAcknowledgement with the nested shell's name.
type NeedsAcknowledgementError = tmux.NeedsAcknowledgementError

// describeImage is what the Operator is shown of a program: the image's base name and folder, cleaned and capped. A process can rename itself (prctl, perl's $0) to look like the agent, so ps's
// command name is never used; with no readable image the program is "an unknown program (pid N)" and unidentified is true.
func describeImage(pid int, image string) (program, folder string, unidentified bool) {
	if image == "" {
		return fmt.Sprintf("an unknown program (pid %d)", pid), "", true
	}
	img := strings.ReplaceAll(image, "\\", "/")
	return visibleName(path.Base(img), 64), visibleTail(path.Dir(img), 120), false
}

// AgentRecorder is implemented by terminals that can name and record an agent's single foreground program (tmux, the PTY backend).
type AgentRecorder interface {
	// AgentCandidate: the single foreground program, or why not (why is "" when there is one). cliPath is the session's resolved CLI path (or ""): on Windows the cmd that runs it
	// (claude.cmd) is the agent's own launcher, not a nested shell, and the candidate's Under says so.
	AgentCandidate(ctx context.Context, name, agentType, sessionID, cliPath string) (cand AgentCandidate, why string, err error)
	// RecordAgent records want when it is still exactly the one foreground program; ErrCandidateChanged / ErrNoCandidate otherwise.
	RecordAgent(ctx context.Context, name, agentType, sessionID string, want AgentCandidate) (AgentCandidate, error)
}

func fromTmux(c tmux.Candidate) AgentCandidate {
	image := tmux.ProgramImage(c.PID)
	var args []string
	if interpreterName(image) != "" {
		args = tmux.ProgramArgs(c.PID) // read for one comparison (ScriptIsCLI) and dropped
	}
	program, folder, unidentified := describeImage(c.PID, image)
	return AgentCandidate{PID: c.PID, Start: c.Start, Program: program, Folder: folder, Unidentified: unidentified, Under: c.Under, Image: image, Script: interpreterScript(image, args)}
}

// AgentCandidate implements AgentRecorder for tmux.
func (t *TmuxSessionTerminal) AgentCandidate(ctx context.Context, name, agentType, sessionID, _ string) (AgentCandidate, string, error) {
	c, why, err := t.client.AgentCandidate(ctx, name, agentType, sessionID)
	if err != nil || why != "" {
		return AgentCandidate{}, why, err
	}
	return fromTmux(c), "", nil
}

// RecordAgent implements AgentRecorder for tmux.
func (t *TmuxSessionTerminal) RecordAgent(ctx context.Context, name, agentType, sessionID string, want AgentCandidate) (AgentCandidate, error) {
	c, err := t.client.RecordAgent(ctx, name, agentType, sessionID, tmux.AgentProc{PID: want.PID, Start: want.Start}, want.AcknowledgeNested)
	if err != nil {
		return AgentCandidate{}, err
	}
	return fromTmux(c), nil
}

// AgentCandidate implements AgentRecorder for the PTY backend.
func (p *PTYSessionTerminal) AgentCandidate(_ context.Context, name, _, sessionID, cliPath string) (AgentCandidate, string, error) {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return AgentCandidate{}, "", err
	}
	return p.backend.AgentCandidate(key, cliPath)
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
	AgentCandidate(cliPath string) (cand AgentCandidate, why string, err error)
	RecordAgent(want AgentCandidate) (AgentCandidate, error)
}

// AgentCandidate is the single foreground program of a session's terminal. A gone session or a backend that cannot say is ErrTerminalGone / ErrNoCandidate.
func (m *PTYBackend) AgentCandidate(name, cliPath string) (AgentCandidate, string, error) {
	m.mu.RLock()
	s, found := m.sessions[name]
	m.mu.RUnlock()
	if !found || !s.isRunning() {
		return AgentCandidate{}, "", ErrTerminalGone
	}
	if r, can := s.proc.(agentRecordProc); can {
		return r.AgentCandidate(cliPath)
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
	c, err := tmux.RecordAgentForShell(name, sp.ShellPID(), tmux.AgentProc{PID: want.PID, Start: want.Start}, want.AcknowledgeNested)
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
