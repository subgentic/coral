package routes

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/tracking"
)

// CloseAsk closes a question the Operator answered somewhere the board did not see (#11417): POST /api/board/{project}/asks/{messageID}/close {subscriber_id, note}. Only the Operator's own reply on the board
// closed one, so a question answered in chat or in an artifact comment stayed open and the health check repeated it. The asker, the Operator or the board's orchestrator may close it, with a note that says where
// it was answered (shown with the ask). The caller is the one the identity layer proves, as for any board write.
func (h *BoardHandler) CloseAsk(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through the Hub (#13450) a question is put away, or brought back, by the account this computer is linked to and nobody else: a grantee, a viewer and a guide get 403 owner_only before anything below reads the body
		return
	}
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "messageID"))
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid message id")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"` // accepted for the command line's sake and ignored: the verified caller closes
		Note         string `json:"note"`
		Withdraw     bool   `json:"withdraw"` // the asker (or the board's orchestrator) takes the question back (#13147): the note is "withdrawn by <who>", the reason after it is optional
		Undo         bool   `json:"undo"`     // open the question again (the Operator's Undo of an Ignore, #11552): no note, the same callers, nothing posted
		Unanswer     bool   `json:"unanswer"` // with undo: an ANSWERED question is open again too (#15792, the Activity thread's Reopen question): the replies stay, only a later one answers it
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	// Who closes is the identity layer's verified actor in every mode, never the name the body claims: an agent that could name itself the Operator, or the asker, could hide a question from the Operator's
	// Needs you (Security on #11417). A caller nothing backs (no credential) is refused.
	actor, verified := actorName(callerActor(r))
	// Through the Hub the account this computer is linked to is the Operator for this route (#13883). The close route is an owner route of the tunnel table, and TunnelIdentityGuard lets every owner POST
	// pass without making it the Operator's, so the identity layer named the Hub user's label here and mayCloseAsk refused it. refuseNonOwner above has already admitted only the owner (a grantee, a viewer
	// and a guide were answered owner_only); the authentic connector stamp and the owner check are asked again so this reads on its own. Only this route takes it: nothing else treats the owner's label as the Operator.
	var hubOwner *callerIdentity
	if a := callerActor(r); a.Kind == ActorHub && !strings.EqualFold(a.Name, "Operator") && cloud.TunneledAuthentic(r) {
		if oid := hubOwnerRequest(r); oid.owner {
			hubOwner = &oid
			actor, verified = "Operator", true
		}
	}
	if !verified {
		writeError(w, http.StatusForbidden, "unverified", "closing a question needs a verified caller: an agent's token, the Operator, or the Hub")
		return
	}
	note := strings.TrimSpace(clitext.Clean(body.Note))
	if body.Withdraw && !body.Undo {
		note = withdrawnNote(actor, note)
	}
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
	if body.Withdraw && !body.Undo && !h.mayWithdrawAsk(r, project, actor, asker) {
		writeError(w, http.StatusForbidden, "not_allowed", "only the agent that asked, or the board's orchestrator, may withdraw a question (the Operator ignores one)")
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
		if body.Unanswer {
			if err := h.bs.ReopenAskAnswer(r.Context(), project, id); err != nil {
				errInternalServer(w, "could not open the question again")
				return
			}
			reopened = true
		}
		h.recordAskActivity(r, board.ActUnignore, project, id, "")
		if hubOwner != nil {
			recordHubOwnerAction(r.Context(), h.bs, *hubOwner, r.Method, r.URL.Path, project, http.StatusOK)
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
	if strings.EqualFold(actor, "Operator") && humanInputCaller(r) { // the Operator's own Ignore, not an agent closing its own question
		h.recordAskActivity(r, board.ActIgnore, project, id, note)
		inboxActioned(r, tracking.InboxAsk, "", "dismiss", time.Time{}) // the Inbox's numbers (#7512)
	}
	if hubOwner != nil {
		recordHubOwnerAction(r.Context(), h.bs, *hubOwner, r.Method, r.URL.Path, project, http.StatusOK)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed_by": actor, "withdrawn": body.Withdraw})
}

// withdrawnNote is the note a withdrawn question carries: who took it back, and why when they said.
func withdrawnNote(actor, reason string) string {
	note := "withdrawn by " + actor
	if reason != "" {
		note += ": " + reason
	}
	return note
}

// mayWithdrawAsk: only the agent that asked, or the board's orchestrator (#13147). The Operator is not one: a question is the Operator's to answer or ignore, and a withdraw is the asker taking it back.
func (h *BoardHandler) mayWithdrawAsk(r *http.Request, project, actor, asker string) bool {
	if strings.EqualFold(actor, "Operator") {
		return false
	}
	return h.mayCloseAsk(r, project, actor, asker)
}

// mayCloseAsk: the asker, the Operator, or the board's orchestrator.
func (h *BoardHandler) mayCloseAsk(r *http.Request, project, actor, asker string) bool {
	if board.SameIdentity(actor, asker) || strings.EqualFold(actor, "Operator") {
		return true
	}
	sub, err := h.bs.GetProjectSubscription(r.Context(), project, actor)
	return err == nil && sub != nil && isOrchestratorSubscriber(sub, actor)
}
