package routes

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/ptymanager"
)

// The dialog timeout for opencode (dialog_timeout.go): its requests come from its own server, not its screen, so they are closed there, with its reject reply (never once or always). The order
// and the checks are the screen path's: the request has been open for after, it was never closed before, nobody is present, auto-accept is off, the agent's lock is free, the gate would let the
// notice through; then, inside the lock, the request is looked up again in the server's own list, rejected, and the notice is typed once the server no longer lists it.

// opencodeOldestDue is the agent's oldest open request that has waited at least after, or false.
func opencodeOldestDue(reqs []opencode.PermissionRequest, after time.Duration, now time.Time) (opencode.PermissionRequest, bool) {
	var due opencode.PermissionRequest
	found := false
	for _, p := range reqs {
		if p.ID == "" || p.At.IsZero() || now.Sub(p.At) < after {
			continue
		}
		if !found || p.At.Before(due.At) {
			due, found = p, true
		}
	}
	return due, found
}

// opencodeDialogTimeout is one opencode agent's try, as dialogTimeout is for a screen.
func (h *SessionsHandler) opencodeDialogTimeout(ctx context.Context, a liveAgent, after time.Duration, now time.Time) string {
	if h.opencode == nil {
		return timeoutNotDue
	}
	req, due := opencodeOldestDue(h.opencode.AgentPermissions(a.sid), after, now)
	if !due || h.episodes.closed(a.sid, req.ID) {
		return timeoutNotDue
	}
	if h.personPresent(a.sid, now) {
		return timeoutPresent
	}
	if st, err := h.ss.GetAutoAcceptState(ctx, a.sid); err != nil || st.Enabled {
		return timeoutExcluded
	}
	pane := naming.SessionName(a.agentType, a.sid)
	unlock, ok := h.tryLockAgent(a.sid)
	if !ok {
		return timeoutBusy
	}
	defer unlock()
	if h.noticeWouldHold(ctx, pane, a) {
		return timeoutGateHolds
	}
	again, still := opencodeOldestDue(h.opencode.AgentPermissions(a.sid), after, now)
	if !still || again.ID != req.ID || h.personPresent(a.sid, now) {
		return timeoutChanged
	}
	if !h.episodes.take(a.sid, req.ID, now) {
		return timeoutNotDue
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := h.opencode.ReplyPermission(rctx, a.sid, req.ID, "reject")
	cancel()
	if err != nil {
		slog.Warn("dialog timeout: opencode did not take the reject", "session", a.sid, "error", err)
		h.recordDialogClosed(ctx, a, req.At, now, dialogDeclined, timeoutSendFailed)
		return timeoutSendFailed
	}
	outcome := timeoutNoBox
	if h.waitOpencodeGone(ctx, a.sid, req.ID) {
		time.Sleep(promptSettle)
		delivery, err := deliverNoticeRetrying(ctx, h.terminal, pane, a.agentType, a.sid, dialogTimeoutNotice, "dialog timeout notice")
		outcome = timeoutNotTyped
		if err == nil && delivery == ptymanager.Sent {
			outcome = timeoutDone
		}
	}
	h.recordDialogClosed(ctx, a, req.At, now, dialogDeclined, outcome)
	return outcome
}

// waitOpencodeGone waits, up to promptClearTimeout, for the server to no longer list the request.
func (h *SessionsHandler) waitOpencodeGone(ctx context.Context, sid, id string) bool {
	deadline := time.Now().Add(promptClearTimeout)
	for {
		open := false
		for _, p := range h.opencode.AgentPermissions(sid) {
			open = open || p.ID == id
		}
		if !open {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(promptPollEvery):
		}
	}
}
