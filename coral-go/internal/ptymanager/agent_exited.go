package ptymanager

import (
	"context"
	"log/slog"
	"path"
	"strings"
	"sync/atomic"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/logparse"
)

// ShellIdleChecker is implemented by terminals that can tell whether an agent's
// own shell is idle, with nothing (no agent CLI) running in it (#3219).
type ShellIdleChecker interface {
	AgentShellIdle(ctx context.Context, name, agentType, sessionID string) (idle bool, shell string, ok bool)
}

// IsTerminalAgent reports whether a session is a 'terminal' agent: its terminal IS a
// shell, so automated text (a notification naming a sender, a message preview, a task
// title) must never be typed there. Quoting can't make arbitrary text safe for a shell:
// $( ) and backticks expand inside double quotes (#3376). agentType "" is read from the
// session name.
func IsTerminalAgent(name, agentType string) bool {
	if agentType == "" {
		agentType, _ = logparse.ParseSessionName(name)
	}
	return agentType == at.Terminal
}

// AgentExited reports whether an agent's CLI has exited and left its terminal at
// a plain shell prompt, so automated input (nudges, notifications, scheduled
// prompts, auto-accept) must not be typed there: a shell would run it as a
// command (#3219). It is false when it cannot tell (the terminal is gone, the
// backend or platform cannot say), and always false for a 'terminal' agent,
// whose shell is the agent. Input the user types in the dashboard is never
// checked.
func AgentExited(ctx context.Context, term any, name, agentType, sessionID string) (bool, string) {
	if agentType == "" {
		agentType, _ = logparse.ParseSessionName(name)
	}
	if agentType == at.Terminal {
		return false, ""
	}
	c, ok := term.(ShellIdleChecker)
	if !ok {
		return false, ""
	}
	idle, shell, ok := c.AgentShellIdle(ctx, name, agentType, sessionID)
	if !ok {
		return false, ""
	}
	return idle, shell
}

// AgentCLIRunning reports whether the single foreground program of the agent's pane, read from the terminal, is the agent's own CLI: its image (or, for a script run by node, bun or deno, the
// script) is named binary, directly below the pane's shell and with its image readable. A positive reading only (#13431): false for a terminal agent, a terminal that cannot say, an idle shell, a
// pager, an editor, a REPL or anything else a person runs in the pane. The name is not authentication (a program can be named like the CLI), the same trust the notice record has.
func AgentCLIRunning(ctx context.Context, term any, name, agentType, sessionID, binary string) bool {
	if agentType == "" {
		agentType, _ = logparse.ParseSessionName(name)
	}
	if agentType == at.Terminal || binary == "" {
		return false
	}
	rec, ok := term.(AgentRecorder)
	if !ok {
		return false
	}
	cand, why, err := rec.AgentCandidate(ctx, name, agentType, sessionID, "")
	if err != nil || why != "" || cand.Unidentified || cand.Under != "" || cand.Image == "" {
		return false
	}
	return programIs(cand.Image, binary) || (cand.Script != "" && programIs(cand.Script, binary))
}

// programIs is whether a program's path has the base name binary (case-insensitive, without a .exe, .cmd or .js ending).
func programIs(p, binary string) bool {
	base := path.Base(strings.ReplaceAll(p, "\\", "/"))
	for _, ext := range []string{".exe", ".cmd", ".js", ".mjs"} {
		base = strings.TrimSuffix(strings.ToLower(base), ext)
	}
	return base == strings.ToLower(binary)
}

// AgentShellIdle implements ShellIdleChecker for tmux.
func (t *TmuxSessionTerminal) AgentShellIdle(ctx context.Context, name, agentType, sessionID string) (bool, string, bool) {
	idle, shell, err := t.client.AgentShellIdle(ctx, name, agentType, sessionID)
	if err != nil {
		return false, "", false
	}
	return idle, shell, true
}

// AgentUnknownShell implements UnknownShellChecker for the PTY backend (Unix).
func (p *PTYSessionTerminal) AgentUnknownShell(_ context.Context, name, _, sessionID string) (string, bool) {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return "", false
	}
	return p.backend.OtherShell(key)
}

// AgentShellIdle implements ShellIdleChecker for the PTY backend.
func (p *PTYSessionTerminal) AgentShellIdle(_ context.Context, name, _, sessionID string) (bool, string, bool) {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return false, "", false
	}
	return p.backend.ShellIdle(key)
}

// UnknownShellChecker is implemented by terminals that can name a shell of unknown contents in an agent's terminal: on Windows a shell other than a verified PowerShell or cmd with no
// program seen beside it (git-bash, WSL), on Unix a shell a person started below the pane's shell. What runs in it is not the agent (Security on #216, #387).
type UnknownShellChecker interface {
	AgentUnknownShell(ctx context.Context, name, agentType, sessionID string) (shell string, ok bool)
}

// UnknownShell names the shell of unknown contents in an agent's terminal, read now, or "" (none, or the terminal cannot tell).
func UnknownShell(ctx context.Context, term any, name, agentType, sessionID string) string {
	c, ok := term.(UnknownShellChecker)
	if !ok {
		return ""
	}
	sh, ok := c.AgentUnknownShell(ctx, name, agentType, sessionID)
	if !ok {
		return ""
	}
	return sh
}

// The settle window of a launch (#13658): how long it waits for a shell that looks unknown to go away before it refuses, and how often it looks again. A freshly created pane's shell is still starting, and a child
// shell of that startup (an rc file, a version manager, a prompt's setup) is, for a moment, what the process walk calls a shell of unknown contents; under load the moment is long enough for Coral's one look to land
// in it. A shell a person started stays, so it is still refused, a window later. Atomics, so a test sets them with SetUnknownShellSettle and no goroutine another test left reads a plain variable (#5266).
var (
	unknownShellSettle atomic.Int64 // nanoseconds
	unknownShellPoll   atomic.Int64
)

func init() {
	unknownShellSettle.Store(int64(2 * time.Second))
	unknownShellPoll.Store(int64(150 * time.Millisecond))
}

// SetUnknownShellSettle sets the settle window and the poll interval, and returns what puts them back (for the tests).
func SetUnknownShellSettle(window, poll time.Duration) (restore func()) {
	w, p := unknownShellSettle.Swap(int64(window)), unknownShellPoll.Swap(int64(poll))
	return func() { unknownShellSettle.Store(w); unknownShellPoll.Store(p) }
}

// SettledUnknownShell is UnknownShell with a settle window: a shell that is named is looked for again until TWO looks in a row, one poll apart, name none, or the settle window has passed, and only a shell still named
// is returned (Security's SHOULD on #13658: the process walk can miss a shell for a moment, and one missed look must not type a launch line into a person's shell). The rule of the guard is unchanged (a shell of unknown
// contents gets no launch line); only a shell that was never one is no longer mistaken for one. "" when none at the first look (one look, no wait, for a terminal with nothing named).
func SettledUnknownShell(ctx context.Context, term any, name, agentType, sessionID string) string {
	sh := UnknownShell(ctx, term, name, agentType, sessionID)
	if sh == "" {
		return ""
	}
	deadline := time.Now().Add(time.Duration(unknownShellSettle.Load()))
	clean := 0                                     // clean looks in a row since a shell was last named
	for clean > 0 || time.Now().Before(deadline) { // a clean look is confirmed by one more even past the window's end
		select {
		case <-ctx.Done():
			return sh // the caller gave up: the last named shell stands
		case <-time.After(time.Duration(unknownShellPoll.Load())):
		}
		if now := UnknownShell(ctx, term, name, agentType, sessionID); now != "" {
			sh, clean = now, 0
		} else if clean++; clean >= 2 {
			return ""
		}
	}
	return sh
}

// UnknownShellRefusal is what Coral says when it types no launch line into a terminal running a shell of unknown contents.
func UnknownShellRefusal(shell string) string {
	return "this terminal is running " + shell + ": Coral can't see what runs in it, so it typed nothing. Start the agent yourself in that terminal, or restart the terminal."
}

// AgentExitedForLaunch is AgentExited for the paths that would type a launch line into the shell an exited agent left (Wake's resume in
// the same terminal, the launch prompt's wait, the reconciler's marking an agent ended, a failed send's marking it ended). A terminal
// whose shell is of unknown contents (UnknownShell) is not "exited" for them: what runs in that shell may be a program, and a launch line
// would be typed into it. refusal says why (UnknownShellRefusal); it is "" otherwise. Notices keep using AgentExited, which withholds
// them from such a terminal too (Security on #216).
func AgentExitedForLaunch(ctx context.Context, term any, name, agentType, sessionID string) (exited bool, fg, refusal string) {
	exited, fg = AgentExited(ctx, term, name, agentType, sessionID)
	if !exited {
		return false, fg, ""
	}
	if sh := UnknownShell(ctx, term, name, agentType, sessionID); sh != "" {
		slog.Info("[terminal] a launch line was refused: a shell of unknown contents is in the terminal", "session", name, "shell", sh, "tree", shellTreeOf(ctx, term, name, agentType, sessionID)) // the process names and states only, so the next one can be told apart (#12222)
		return false, sh, UnknownShellRefusal(sh)
	}
	return true, fg, ""
}

// AgentUnknownShell implements UnknownShellChecker for tmux: the shell a person started below the pane's shell (tmux.ShellNested).
func (t *TmuxSessionTerminal) AgentUnknownShell(ctx context.Context, name, agentType, sessionID string) (string, bool) {
	sh, err := t.client.NestedShell(ctx, name, agentType, sessionID)
	if err != nil {
		return "", false
	}
	return sh, true
}

// ShellTreeReporter is implemented by terminals that can draw what is running below an agent's shell, for the log (tmux.ShellTreeOf).
type ShellTreeReporter interface {
	AgentShellTree(ctx context.Context, name, agentType, sessionID string) string
}

func shellTreeOf(ctx context.Context, term any, name, agentType, sessionID string) string {
	if c, ok := term.(ShellTreeReporter); ok {
		return c.AgentShellTree(ctx, name, agentType, sessionID)
	}
	return ""
}

// AgentShellTree implements ShellTreeReporter for tmux.
func (t *TmuxSessionTerminal) AgentShellTree(ctx context.Context, name, agentType, sessionID string) string {
	tree, err := t.client.ShellTree(ctx, name, agentType, sessionID)
	if err != nil {
		return ""
	}
	return tree
}

// AgentShellTree implements ShellTreeReporter for the PTY backend.
func (p *PTYSessionTerminal) AgentShellTree(_ context.Context, name, _, sessionID string) string {
	key, err := p.keyFor(name, sessionID)
	if err != nil {
		return ""
	}
	return p.backend.ShellTree(key)
}
