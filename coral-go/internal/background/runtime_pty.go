package background

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/terminalinput"
)

// PTYRuntime implements AgentRuntime using native PTY sessions.
// Used on Windows (ConPTY) or macOS App Store (no tmux available).
type PTYRuntime struct {
	backend *ptymanager.PTYBackend
}

// HumanInputSince implements ptymanager.HumanInputReader: whether a person typed in
// the agent's terminal after t (the gate's PTY rule, #3482).
func (r *PTYRuntime) HumanInputSince(name, sessionID string, t time.Time) bool {
	if sessionID != "" { // the agent's own terminal (#3704)
		for _, s := range r.backend.ListSessions() {
			if s.SessionID == sessionID {
				return r.backend.HumanInputSince(naming.SessionName(s.AgentType, s.SessionID), t)
			}
		}
		return false
	}
	return r.backend.HumanInputSince(name, t)
}

// NewPTYRuntime creates a PTYRuntime wrapping the given PTY backend.
func NewPTYRuntime(backend *ptymanager.PTYBackend) *PTYRuntime {
	return &PTYRuntime{backend: backend}
}

func (r *PTYRuntime) SpawnAgent(ctx context.Context, name, workDir, logFile, command string) error {
	ptymanager.ForgetSession(name) // what Coral remembers of the old process is not true of a new one
	// Extract agent type and session ID from name format "{type}-{uuid}"
	agentType, sessionID := parseSessionName(name)
	if agentType == "" {
		agentType = "agent"
	}
	if sessionID == "" {
		sessionID = name
	}

	return r.backend.Spawn(name, agentType, workDir, sessionID, command, 200, 50)
}

func (r *PTYRuntime) SendInput(ctx context.Context, o terminalinput.Origin, name, text string) error {
	// Type the text, then submit with the platform's Enter key (unless the gate's check withholds it).
	return r.backend.SendText(ctx, o, name, text)
}

// SendPrompt implements ptymanager.PromptSender: automated text as one bracketed
// paste and its Enter, while the agent has bracketed paste on (#3457).
func (r *PTYRuntime) SendPrompt(ctx context.Context, o terminalinput.Origin, name, text, _, _ string) error {
	return r.backend.SendPrompt(ctx, o, name, text)
}

// SendEnter implements ptymanager.EnterSender (#3431, #3457).
func (r *PTYRuntime) SendEnter(_ context.Context, name, _, _ string) error {
	return r.backend.SendInput(terminalinput.Internal, name, []byte("\r"))
}

// SendRawInput implements ptymanager.RawInputSender: single keys typed into the agent's terminal, as the dashboard's session terminal does. The gate dismisses Claude's session survey with a 0 through it (#6974).
func (r *PTYRuntime) SendRawInput(ctx context.Context, o terminalinput.Origin, name string, keys []string, agentType, sessionID string) error {
	return ptymanager.NewPTYSessionTerminal(r.backend).SendRawInput(ctx, o, name, keys, agentType, sessionID)
}

func (r *PTYRuntime) KillAgent(ctx context.Context, name string) error {
	ptymanager.ForgetSession(name) // what Coral remembers of the old process is not true of a new one
	return r.backend.Kill(name)
}

func (r *PTYRuntime) IsAlive(ctx context.Context, name string) bool {
	return r.backend.IsRunning(name)
}

func (r *PTYRuntime) ListAgents(ctx context.Context) ([]AgentInfo, error) {
	sessions := r.backend.ListSessions()
	agents := make([]AgentInfo, 0, len(sessions))
	for _, s := range sessions {
		agents = append(agents, AgentInfo{
			AgentName:        s.AgentName,
			AgentType:        s.AgentType,
			SessionID:        s.SessionID,
			WorkingDirectory: s.WorkingDir,
		})
	}
	return agents, nil
}

// Verify interface compliance at compile time.
var _ AgentRuntime = (*PTYRuntime)(nil)
var _ AgentRuntime = (*TmuxRuntime)(nil)

// FormatSessionName builds a session name from agent type and session ID.
func FormatSessionName(agentType, sessionID string) string {
	return naming.SessionName(agentType, sessionID)
}

// AgentShellIdle reports whether an agent's terminal is back at its idle shell,
// for ptymanager.AgentExited (#3219).
func (r *PTYRuntime) AgentShellIdle(_ context.Context, name, _, _ string) (bool, string, bool) {
	return r.backend.ShellIdle(name)
}

// AgentNoticeTarget says whether a board nudge may be typed into the agent's terminal: only while the recorded agent process is its foreground program (ptymanager.NoticeBlocked, #389).
func (r *PTYRuntime) AgentNoticeTarget(_ context.Context, name, _, _ string) (ok, wait bool, why string, known bool) {
	v, found := r.backend.AgentNoticeVerdict(name)
	if !found {
		return false, false, "", false
	}
	return v.OK, v.Wait, v.Reason, true
}

// AgentUnknownShell names a shell of unknown contents in the agent's terminal (Windows: git-bash, WSL) or a shell a person started below the agent's shell (Unix), for
// ptymanager.AgentExitedForLaunch (Security on #216, #387).
func (r *PTYRuntime) AgentUnknownShell(_ context.Context, name, _, _ string) (string, bool) {
	return r.backend.OtherShell(name)
}

// AgentScreen implements ptymanager.ScreenReader: the session's output rendered as the
// screen (as the HTTP senders read it), read by the automated-input gate before typing
// (#3431).
func (r *PTYRuntime) AgentScreen(_ context.Context, name, _, _ string) (string, error) {
	return r.backend.RenderedScreenText(name) // an empty render stays empty: the gate holds rather than guessing
}

// AgentScreenStyled implements ptymanager.StyledScreenReader: AgentScreen with faint cells marked.
func (r *PTYRuntime) AgentScreenStyled(_ context.Context, name, _, _ string) (string, error) {
	return r.backend.RenderedScreenStyledText(name)
}

// HasRenderedScreen implements ptymanager.RenderedScreen: AgentScreen is the rendered screen.
func (r *PTYRuntime) HasRenderedScreen() bool { return true }
