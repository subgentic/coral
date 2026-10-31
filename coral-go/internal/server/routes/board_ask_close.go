package routes

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// CloseAsk closes a question the Operator answered somewhere the board did not see (#11417): POST /api/board/{project}/asks/{messageID}/close {subscriber_id, note}. Only the Operator's own reply on the board
// closed one, so a question answered in chat or in an artifact comment stayed open and the health check repeated it. The asker, the Operator or the board's orchestrator may close it, with a note that says where
// it was answered (shown with the ask). The caller is the one the identity layer proves, as for any board write.
func (h *BoardHandler) CloseAsk(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "messageID"))
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid message id")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"` // accepted for the command line's sake and ignored: the verified caller closes
		Note         string `json:"note"`
		Undo         bool   `json:"undo"` // open the question again (the Operator's Undo of an Ignore, #11552): no note, the same callers, nothing posted
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	// Who closes is the identity layer's verified actor in every mode, never the name the body claims: an agent that could name itself the Operator, or the asker, could hide a question from the Operator's
	// Needs you (Security on #11417). A caller nothing backs (no credential) is refused.
	actor, verified := actorName(callerActor(r))
	if !verified {
		writeError(w, http.StatusForbidden, "unverified", "closing a question needs a verified caller: an agent's token, the Operator, or the Hub")
		return
	}
	note := strings.TrimSpace(clitext.Clean(body.Note))
	if note == "" && !body.Undo {
		errBadRequest(w, "a note is required: say where it was answered")
		return
	}
	asker, err := h.bs.AskAsker(r.Context(), project, id)
	if err != nil {
		errNotFound(w, "no question of this board has that message id")
		return
	}
	if !h.mayCloseAsk(r, project, actor, asker) {
		writeError(w, http.StatusForbidden, "not_allowed", "only the asker, the Operator or the board's orchestrator may close a question")
		return
	}
	if body.Undo {
		if !humanInputCaller(r) { // an Ignore is the Operator's: the agent that asked, the orchestrator and every other token are refused, so no agent reopens what the Operator put away (Security's SHOULD on #11576)
			writeError(w, http.StatusForbidden, "owner_only", "only the person at this computer can open a question again")
			return
		}
		reopened, err := h.bs.ReopenAsk(r.Context(), project, id)
		if err != nil {
			if errors.Is(err, board.ErrAskUnknown) {
				errNotFound(w, "no question of this board has that message id")
				return
			}
			errInternalServer(w, "could not open the question again")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reopened": reopened})
		return
	}
	if err := h.bs.CloseAsk(r.Context(), project, id, actor, note); err != nil {
		if errors.Is(err, board.ErrAskUnknown) {
			errNotFound(w, "no question of this board has that message id")
			return
		}
		errInternalServer(w, "could not close the question")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed_by": actor})
}

// mayCloseAsk: the asker, the Operator, or the board's orchestrator.
func (h *BoardHandler) mayCloseAsk(r *http.Request, project, actor, asker string) bool {
	if board.SameIdentity(actor, asker) || strings.EqualFold(actor, "Operator") {
		return true
	}
	sub, err := h.bs.GetProjectSubscription(r.Context(), project, actor)
	return err == nil && sub != nil && isOrchestratorSubscriber(sub, actor)
}
