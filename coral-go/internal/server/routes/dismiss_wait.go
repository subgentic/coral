package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/store"
)

// DismissWait is the Operator's way to clear a wait that is no longer true (#11352): a "Permission needed" card and its Inbox row that stay after the agent went on. It writes a request_resolved
// event marked dismissed, which the state derivation reads as the open request being gone. It types nothing to the agent and answers nothing in its terminal: only Coral's own record of the
// wait changes. Operator-only (an agent's token is refused: the route is in the census as b), and only for a request of the agent's own kinds, never a sign-in or a launch prompt.
// POST /api/sessions/live/{name}/dismiss-wait
func (h *SessionsHandler) DismissWait(w http.ResponseWriter, r *http.Request) {
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
	switch st.WaitingKind {
	case "permission", "question", "plan":
	default:
		errConflict(w, "Only a permission, question or plan can be dismissed here.")
		return
	}
	sid := body.SessionID
	detail := `{"dismissed":true}`
	ev := &store.AgentEvent{AgentName: ls.AgentName, SessionID: &sid, EventType: "request_resolved", Summary: "The Operator dismissed the wait", DetailJSON: &detail}
	if _, err := h.ts.InsertAgentEvent(r.Context(), ev); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	h.pending.markRequest(body.SessionID, false)
	h.kickFeedForRequestChange(body.SessionID, "request_resolved")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": true})
}
