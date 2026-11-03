package routes

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// The Operator's click on a button an agent declared on a question (#11643). Two routes, both the Operator's alone (the person at this computer, or through Coral Hub the owner; never an agent's token, a
// guide or a script):
//
//	POST /api/board/{project}/asks/{messageID}/buttons/{buttonID}/claim   claims the button once and answers with the STORED action; the page runs only what that answer says. A reply button is run here:
//	                                                                        the server posts its stored label as the Operator's reply, marked as a click, and closes the question.
//	POST /api/board/{project}/asks/{messageID}/buttons/{buttonID}/settle  {"outcome": "done" | "failed"}: the page ran an open or wake action; done closes the question, failed gives the button back.
//
// The body of neither route names an action, an argument or a text: nothing a page or a forged request sends can change what a button does.

// buttonClickCaller refuses everyone but the person. It reports whether the caller may go on.
func buttonClickCaller(w http.ResponseWriter, r *http.Request) bool {
	if refuseNonOwner(w, r) {
		return false
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "owner_only", "only the person at this computer can use a button on a question")
		return false
	}
	return true
}

func buttonIDs(w http.ResponseWriter, r *http.Request) (askID, buttonID int64, ok bool) {
	askID, err1 := parseID(chi.URLParam(r, "messageID"))
	buttonID, err2 := parseID(chi.URLParam(r, "buttonID"))
	if err1 != nil || err2 != nil || askID <= 0 || buttonID <= 0 {
		errBadRequest(w, "invalid ids")
		return 0, 0, false
	}
	return askID, buttonID, true
}

// ClaimAskButton answers POST .../buttons/{buttonID}/claim.
func (h *BoardHandler) ClaimAskButton(w http.ResponseWriter, r *http.Request) {
	if !buttonClickCaller(w, r) {
		return
	}
	project := urlParam(r, "project")
	askID, buttonID, ok := buttonIDs(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	b, err := h.bs.AskButtonByID(ctx, project, askID, buttonID)
	if errors.Is(err, board.ErrButtonUnknown) {
		errNotFound(w, "no such button on this question")
		return
	} else if err != nil {
		errInternalServer(w, "could not read the button")
		return
	}
	// The same checks as at the declaration, again at the click: the target is still this team's, the question is still open, the board is not paused. A refusal keeps the button unused.
	gone := func(why string) { writeError(w, http.StatusConflict, "button_gone", why) }
	if closed, _ := h.bs.AskIsClosed(ctx, project, askID); closed {
		writeError(w, http.StatusConflict, "ask_closed", "this question is closed")
		return
	}
	if h.IsPaused(project) {
		writeError(w, http.StatusConflict, "board_paused", "the board is paused")
		return
	}
	switch b.Action {
	case board.ActionOpenTask:
		id, _ := strconv.ParseInt(b.Arg, 10, 64)
		if t, err := h.bs.GetTask(ctx, project, id); err != nil || t == nil {
			gone("task " + b.Arg + " is no longer on this team")
			return
		}
	case board.ActionOpenArtifact:
		if _, ok := h.teamManagedArtifact(ctx, project, b.Arg); !ok {
			gone("that file is no longer one this team can open")
			return
		}
	case board.ActionWake:
		if sub, err := h.bs.GetProjectSubscription(ctx, project, b.Arg); err != nil || sub == nil {
			gone(b.Arg + " is no longer a member of this team")
			return
		}
	}
	claimed, err := h.bs.ClaimAskButton(ctx, project, askID, buttonID, time.Now())
	switch {
	case errors.Is(err, board.ErrAskClosed):
		writeError(w, http.StatusConflict, "ask_closed", "this question is closed")
		return
	case errors.Is(err, board.ErrButtonUsed):
		writeError(w, http.StatusConflict, "already_used", "a button of this question was already used")
		return
	case err != nil:
		errInternalServer(w, "could not use the button")
		return
	}
	out := map[string]any{"ok": true, "id": claimed.ID, "ask_id": askID, "label": claimed.Label, "action": claimed.Action, "arg": claimed.Arg}
	h.recordActivity(r, board.ActAnswer, "question", strconv.FormatInt(askID, 10), project, "", claimed.Label) // the option the Operator chose (text an agent wrote: cleaned, redacted and cut)
	if claimed.Action != board.ActionReply {
		writeJSON(w, http.StatusOK, out)
		return
	}
	// A reply: the stored label is posted as the Operator's reply, said to be a click on the agent's own button, and the question is closed. If the post fails the claim is given back.
	reply, err := h.postButtonReply(r, project, askID, claimed)
	if err != nil {
		_, _ = h.bs.ReleaseAskButton(ctx, project, askID, buttonID)
		errInternalServer(w, "could not post the reply")
		return
	}
	out["reply_id"] = reply
	if err := h.bs.CloseAsk(ctx, project, askID, "Operator", "answered with a button: "+claimed.Label); err != nil {
		writeError(w, http.StatusInternalServerError, "close_failed", "the reply was posted, but the question could not be closed: it stays in Needs you until you close it")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// postButtonReply posts the reply of a button as the Operator: the asker's mention, then words that say it was a click on the asker's own label, never the label alone, so no reader takes it for a typed reply.
func (h *BoardHandler) postButtonReply(r *http.Request, project string, askID int64, b board.AskButton) (int64, error) {
	ctx := r.Context()
	asker, err := h.bs.AskAsker(ctx, project, askID)
	if err != nil {
		return 0, err
	}
	prefix := h.bs.TaskReplyMention(ctx, project, asker).Prefix
	content := clitext.Clean(prefix + "[Coral] The Operator clicked the button labelled \"" + b.Label + "\" that you offered on your question. This is your own button text, not a typed reply.")
	msg, err := h.bs.PostMessage(ctx, project, "Operator", content, nil)
	if err != nil {
		return 0, err
	}
	_ = h.bs.SetAskButtonReply(ctx, project, b.ID, msg.ID) // first: from here the claim is never given back, so a second click cannot post a second reply
	if err := h.bs.RecordReply(ctx, project, msg.ID, askID); err != nil {
		slog.Warn("button reply not linked to its question", "board", project, "message", msg.ID, "error", err)
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	h.goBG(func() { h.resolveMessageWaits(project, "Operator", content) })
	return msg.ID, nil
}

// SettleAskButton answers POST .../buttons/{buttonID}/settle.
func (h *BoardHandler) SettleAskButton(w http.ResponseWriter, r *http.Request) {
	if !buttonClickCaller(w, r) {
		return
	}
	project := urlParam(r, "project")
	askID, buttonID, ok := buttonIDs(w, r)
	if !ok {
		return
	}
	var body struct {
		Outcome string `json:"outcome"`
	}
	if err := decodeJSON(r, &body); err != nil || (body.Outcome != "done" && body.Outcome != "failed") {
		errBadRequest(w, `outcome is "done" or "failed"`)
		return
	}
	ctx := r.Context()
	b, err := h.bs.AskButtonByID(ctx, project, askID, buttonID)
	if errors.Is(err, board.ErrButtonUnknown) {
		errNotFound(w, "no such button on this question")
		return
	} else if err != nil {
		errInternalServer(w, "could not read the button")
		return
	}
	if board.IsOpenAction(b.Action) { // a page that still settles an open button (an older one) changes nothing: the question stays open and the button stays usable (#12785)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": false})
		return
	}
	if b.State != board.ButtonUsed || b.Action == board.ActionReply {
		writeError(w, http.StatusConflict, "not_claimed", "this button was not claimed for the page to run")
		return
	}
	if body.Outcome == "failed" {
		released, err := h.bs.ReleaseAskButton(ctx, project, askID, buttonID)
		if err != nil {
			errInternalServer(w, "could not give the button back")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "released": released})
		return
	}
	if b.Action == board.ActionWake { // one of several wakes: the question stays open for the others, and the last one settles it (#12610)
		if left, err := h.bs.PendingWakeButtons(ctx, project, askID); err == nil && left > 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": false})
			return
		}
	}
	note := strings.TrimSpace("answered with a button: " + b.Label)
	if err := h.bs.CloseAsk(ctx, project, askID, "Operator", note); err != nil {
		writeError(w, http.StatusInternalServerError, "close_failed", "it ran, but the question could not be closed: it stays in Needs you until you close it")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": true})
}
