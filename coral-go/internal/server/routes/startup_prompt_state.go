package routes

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/ptymanager"
)

// startupPromptState is why an agent that has sent no event yet waits on a prompt its CLI drew at launch
// (ptymanager.StartupPromptOnScreen), with the prompt's question, or "" (#4543: Coral Hub's "Needs you" page
// and its alerts read waiting_for_input, and a Codex agent on its hook review or a Claude agent on its trust
// menu looked ready). Read only while the session has no event, through the same per-agent cache as the
// login screen: at most once per loginScreenTTL, or once while the terminal writes nothing.
func (h *SessionsHandler) startupPromptState(name, agentType, sessionID string) (string, string) {
	if sessionID == "" || name == "" {
		return "", ""
	}
	stamp := ""
	if stamper, _ := h.backend.(ptymanager.OutputStamper); stamper != nil {
		if st, ok := stamper.OutputStamp(agentType, sessionID); ok {
			stamp = st
		}
	}
	on, why := h.startupScreens.read(promptReadKey(sessionID, name, agentType), stamp, time.Now(), func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), loginScreenTimeout)
		defer cancel()
		screen, err := h.agentScreen(ctx, name, agentType, sessionID, stamp)
		if err != nil {
			return false, ""
		}
		reason := ptymanager.StartupPromptOnScreen(screen)
		if reason == "" {
			return false, ""
		}
		question := ""
		if s, ok := parsePromptScreen(screen); ok {
			question = s.Question
		}
		return true, reason + "\x00" + question
	})
	if !on {
		return "", ""
	}
	reason, question, _ := strings.Cut(why, "\x00")
	return reason, capCLIText(question)
}

// agentScreen is the agent's visible screen as text: the PTY's rendered (its output is not the screen as
// drawn), else, with an output stamp (tmux), the capture the poll shares, else a ScreenReader's. A terminal
// that is neither is not read (as for the login screen).
func (h *SessionsHandler) agentScreen(ctx context.Context, name, agentType, sessionID, stamp string) (string, error) {
	if rs, ok := h.terminal.(ptymanager.RenderedScreenReader); ok {
		return rs.RenderedScreen(ctx, name, agentType, sessionID)
	}
	if stamp != "" {
		return h.sharedCapture(ctx, name, 40, agentType, sessionID)
	}
	if reader, ok := h.terminal.(ptymanager.ScreenReader); ok {
		return reader.AgentScreen(ctx, name, agentType, sessionID)
	}
	return "", errNoScreen
}

var errNoScreen = errors.New("this terminal has no screen to read")

// rateLimitNoticeState is the question of Codex's "Approaching rate limits" notice when it is open on an agent that has already sent events (#15485), or "". The notice is drawn after the hooks start, so the
// no-event startup read never sees it, and nothing else says the agent is held behind it: Coral's sends are skipped ("a prompt is open") and no Needs you row asked the person. Read through the same
// per-agent cache, under its own key (a startup read and this one ask different things of the same screen).
func (h *SessionsHandler) rateLimitNoticeState(name, agentType, sessionID string) string {
	if sessionID == "" || name == "" || agentType != "codex" {
		return ""
	}
	stamp := ""
	if stamper, _ := h.backend.(ptymanager.OutputStamper); stamper != nil {
		if st, ok := stamper.OutputStamp(agentType, sessionID); ok {
			stamp = st
		}
	}
	on, _ := h.startupScreens.read(promptReadKey(sessionID, name, agentType)+rateLimitReadSuffix, stamp, time.Now(), func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), loginScreenTimeout)
		defer cancel()
		screen, err := h.agentScreen(ctx, name, agentType, sessionID, stamp)
		if err != nil || !ptymanager.CodexRateLimitNoticeOnScreen(screen) {
			return false, ""
		}
		return true, ""
	})
	if !on {
		return ""
	}
	return rateLimitNoticeSummary
}

const (
	rateLimitReadSuffix    = "|ratelimit"
	rateLimitNoticeSummary = "Approaching rate limits: Codex asks whether to switch to a cheaper model"
)

// forgetPromptReads drops the cached screen reads of a session's startup-style prompts: the prompt was answered, the next state reads what replaced it.
func (h *SessionsHandler) forgetPromptReads(sessionID, name, agentType string) {
	h.startupScreens.forget(promptReadKey(sessionID, name, agentType))
	h.startupScreens.forget(promptReadKey(sessionID, name, agentType) + rateLimitReadSuffix)
	h.startupScreens.forget(promptReadKey(sessionID, name, agentType) + startupReadySuffix)
}
