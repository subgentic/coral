package routes

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/tracking"
)

// DismissWait is the Operator's way to clear a wait that is no longer true (#11352): a "Permission needed" card and its Inbox row that stay after the agent went on. It writes a request_resolved
// event marked dismissed, which the state derivation reads as the open request being gone. It types nothing to the agent and answers nothing in its terminal: only Coral's own record of the
// wait changes. Operator-only (an agent's token is refused: the route is in the census as b), and only for a request of the agent's own kinds, never a sign-in or a launch prompt.
// POST /api/sessions/live/{name}/dismiss-wait
func (h *SessionsHandler) DismissWait(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone: a guest or a grantee gets 403 owner_only (the operator's rule)
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID string `json:"session_id"`
		AgentType string `json:"agent_type"`
	}
	if err := decodeJSON(r, &body); err != nil || body.SessionID == "" {
		errBadRequest(w, "session_id is required")
		return
	}
	// The exact target, as for Send and answer-prompt: a bare name could clear another agent's wait (#3211).
	if _, status, message := h.validateExactLiveTarget(r.Context(), name, body.AgentType, body.SessionID, false); status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	ls, err := h.ss.GetLiveSession(r.Context(), body.SessionID)
	if err != nil || ls == nil {
		errNotFound(w, "No such agent")
		return
	}
	st := h.deriveSingleSessionState(r.Context(), body.SessionID, 0)
	if !st.NeedsInput {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": false})
		return
	}
	sid := body.SessionID
	inboxActioned(r, tracking.InboxAgentWait, st.WaitingKind, "dismiss", st.WaitingSince) // the Inbox's numbers (#7512): the wait's kind, never the agent
	switch st.WaitingKind {
	case "permission", "question", "plan":
	default:
		// A request the machine cannot clear (an input prompt, an elicitation, a sign-in): the Operator hides it from Needs you instead, and the hiding is kept here, per agent and request, so the row, the
		// count and /api/needs-you agree (#11946). The agent's own state is untouched and nothing is sent to it; its next request is its own.
		if err := h.ss.SetWaitIgnored(r.Context(), sid, waitRequestKey(st)); err != nil {
			slog.Warn("could not record the Operator's hiding of a wait", "session_id", sid, "error", err)
			errInternalServer(w, "Could not dismiss it. Try again.")
			return
		}
		h.kickFeedForRequestChange(sid, "request_resolved")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": true, "hidden": true})
		return
	}
	detail := `{"dismissed":true}`
	ev := &store.AgentEvent{AgentName: ls.AgentName, SessionID: &sid, EventType: "request_resolved", Summary: "The Operator dismissed the wait", DetailJSON: &detail}
	if _, err := h.ts.InsertAgentEvent(r.Context(), ev); err != nil {
		slog.Warn("could not record the Operator's dismissal of a wait", "session_id", sid, "error", err) // the cause is logged, never sent: no database text in a response
		errInternalServer(w, "Could not dismiss it. Try again.")
		return
	}
	h.pending.markRequest(body.SessionID, false)
	h.kickFeedForRequestChange(body.SessionID, "request_resolved")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": true})
}
