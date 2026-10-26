package routes

import (
	"context"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
)

// retrySkippedBoardNudge wakes the existing coalesced notifier, never a stored
// input queue. It recounts unread and checks the current screen/draft before
// typing. A successful send clears the skip memo and is deduplicated by the
// notifier; a still-blocked send remains eligible for its next bounded pass.
func (h *SessionsHandler) retrySkippedBoardNudge(ctx context.Context, sessionID, sessionName, eventType string) {
	switch eventType {
	case "request_resolved", "tool_use", "stop", "prompt_submit", "session_reset":
	default:
		return
	}
	if sessionID == "" || h.boardHandler == nil || h.boardHandler.notifyFn == nil {
		return
	}
	skip, ok := ptymanager.SkippedOf(sessionName)
	if !ok || skip.What != "board nudge" {
		return
	}
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || ls == nil || ls.IsSleeping != 0 || ls.IsArchived != 0 || ls.StoppedAt != nil || ls.BoardName == nil || *ls.BoardName == "" {
		return
	}
	if ls.BoardServer != nil && *ls.BoardServer != "" && *ls.BoardServer != "local" {
		return
	}
	if sessionName != naming.SessionName(ls.AgentType, sessionID) {
		return
	}
	h.boardHandler.notifyFn(*ls.BoardName)
}
