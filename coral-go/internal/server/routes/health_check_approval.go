package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// The Operator's approval of a custom check is a question Coral files in Needs you (#20139): the check in words, with an Approve and a Deny button. The click runs on the server, against the record hash the
// question was filed with, so a check that changed since is never approved by an old click. Never through Coral Hub: the person at this computer approves what runs on it.

// askCheckApproval files the approval question for a pending check, and closes any earlier one for the same check (its record is out of date).
func (h *BoardHandler) askCheckApproval(ctx context.Context, project string, c board.HealthCheck) {
	h.closeCheckApprovalAsks(ctx, project, c.Name, "the check changed: a new question replaces this one")
	var names []string
	if subs, err := h.bs.ListSubscribers(ctx, project); err == nil {
		for _, s := range subs {
			names = append(names, s.SubscriberID)
		}
	}
	content := "@Operator [Coral] A custom check waits for your approval: " + c.Name + ".\n" + board.DefuseMentions(c.ApprovalWords(), names) +
		"\nApprove it only if you recognise this exact script. Deny removes the check."
	msg, err := h.bs.PostSystemDefusedMessage(ctx, project, "Coral", content, nil)
	if err != nil {
		slog.Warn("check approval question not posted", "board", project, "check", c.Name, "error", err)
		return
	}
	if err := h.bs.RecordAsk(ctx, project, msg, []string{board.OperatorName}); err != nil {
		slog.Warn("check approval question not recorded", "board", project, "check", c.Name, "error", err)
		return
	}
	arg := board.CheckButtonArg(c.Name, c.RecordHash())
	buttons := []board.AskButton{{Label: "Approve", Action: board.ActionApproveCheck, Arg: arg}, {Label: "Deny", Action: board.ActionDenyCheck, Arg: arg}}
	if err := h.bs.RecordAskButtons(ctx, project, msg.ID, buttons, time.Now()); err != nil {
		slog.Warn("check approval buttons not stored", "board", project, "check", c.Name, "error", err)
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
}

// closeCheckApprovalAsks closes every open approval question of the check.
func (h *BoardHandler) closeCheckApprovalAsks(ctx context.Context, project, name, note string) {
	ids, err := h.bs.OpenCheckApprovalAsks(ctx, project, name)
	if err != nil {
		return
	}
	for _, id := range ids {
		_ = h.bs.CloseAsk(ctx, project, id, "Coral", note)
	}
}

// runCheckButton runs a claimed approve or deny button. It answers the request itself.
func (h *BoardHandler) runCheckButton(w http.ResponseWriter, r *http.Request, project string, askID int64, b board.AskButton, out map[string]any) {
	ctx := r.Context()
	stale := func(code, why string) {
		_ = h.bs.CloseAsk(ctx, project, askID, "Coral", why)
		writeError(w, http.StatusConflict, code, why)
	}
	name, hash, ok := board.SplitCheckButtonArg(b.Arg)
	if !ok {
		stale("check_gone", "this question names no check")
		return
	}
	c, err := h.bs.GetHealthCheck(ctx, project, name)
	if errors.Is(err, board.ErrCheckMissing) {
		stale("check_gone", "the check is no longer on this team")
		return
	} else if err != nil {
		_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID)
		errInternalServer(w, "could not read the check")
		return
	}
	if c.RecordHash() != hash {
		stale("check_changed", "the check changed since this question was filed: look at the new question")
		return
	}
	if b.Action == board.ActionApproveCheck {
		if err := h.bs.ApproveHealthCheck(ctx, project, name, "Operator", hash, time.Now()); err != nil {
			_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID)
			errInternalServer(w, "could not approve the check")
			return
		}
		out["result"] = "approved"
	} else {
		if c.Approved() {
			stale("already_approved", "the check was already approved: remove it with coral-board health check remove")
			return
		}
		if err := h.bs.RemoveHealthCheck(ctx, project, name); err != nil {
			_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID)
			errInternalServer(w, "could not remove the check")
			return
		}
		if err := h.revokeCheck(ctx, project, name); err != nil {
			slog.Warn("check removed, live tokens not ended", "board", project, "check", name, "error", err)
		}
		out["result"] = "denied"
	}
	out["ran"] = true
	_ = h.bs.CloseAsk(ctx, project, askID, "Operator", out["result"].(string)+" check "+name)
	writeJSON(w, http.StatusOK, out)
}

// checkButtonsRefused refuses a check button reached through Coral Hub: it reports whether the request was refused.
func checkButtonsRefused(w http.ResponseWriter, r *http.Request) bool {
	if cloud.Tunneled(r) {
		writeError(w, http.StatusForbidden, "this_computer_only", "approve a check on the computer it runs on, not through Coral Hub")
		return true
	}
	return false
}
