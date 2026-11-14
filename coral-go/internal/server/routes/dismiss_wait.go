package routes

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/tracking"
)

// DismissWait is the Operator's way to put away a wait they have seen (#11352, changed by #14203): it marks the agent's CURRENT request ignored, per agent and request, and never resolves it. It used to write a
// request_resolved event for a permission, question or plan, which cleared the wait and the held-message gate with no evidence from the terminal: Needs you showed 0 and the team page "1 needs attention"
// while the agent sat at its prompt (beta finding 3). Now the wait stays until the agent's own evidence clears it (the box is answered, the prompt is gone, the turn moves on), the held-message gate stays
// held while the box is on screen, and /api/needs-you keeps the agent, flagged still_waiting, so the Inbox, its count and the team page read one source. It types nothing to the agent and answers nothing in
// its terminal: only Coral's own record of what the Operator has seen changes. Operator-only (an agent's token is refused: the route is in the census as b), and only for a request of the agent's own kinds,
// never a sign-in or a launch prompt. POST /api/sessions/live/{name}/dismiss-wait
func (h *SessionsHandler) DismissWait(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone: a guest or a grantee gets 403 owner_only (the operator's rule)
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID   string `json:"session_id"`
		AgentType   string `json:"agent_type"`
		DialogSince string `json:"dialog_since"`
		// Remove: the second action on a wait that is already dismissed and still waiting (#14266): the evidence never came, so the Operator takes the row out of Needs you and its count. A request is told from
		// the next by when the agent raised it, so one raised AGAIN after the turn moved on (identical, the same kind or not) is a new ask and shows again; only a request the agent made itself has such a time.
		Remove bool `json:"remove"`
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
	if body.DialogSince != "" {
		// Only the named screen-dialog episode is hidden. A stale browser cannot
		// dismiss a newer dialog or replace the record of a hook-owned wait.
		field, _ := h.dialogs.field(body.SessionID).(map[string]any)
		since, _ := field["since"].(string)
		parsed, parseErr := time.Parse(time.RFC3339, body.DialogSince)
		if st.NeedsInput || since == "" || parseErr != nil || parsed.UTC().Format(time.RFC3339) != since {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": false})
			return
		}
		if err := h.ss.SetWaitIgnored(r.Context(), body.SessionID, "dialog:"+since); err != nil {
			slog.Warn("could not record dialog dismissal", "session_id", body.SessionID, "error", err)
			errInternalServer(w, "Could not dismiss it. Try again.")
			return
		}
		h.kickFeedForRequestChange(body.SessionID, "request_resolved")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": true, "dialog_hidden": true})
		return
	}
	if !st.NeedsInput {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": false})
		return
	}
	sid := body.SessionID
	if !body.Remove { // a removal is not counted as a dismiss: the Inbox's numbers have no such action (#14266)
		inboxActioned(r, tracking.InboxAgentWait, st.WaitingKind, "dismiss", st.WaitingSince) // the Inbox's numbers (#7512): the wait's kind, never the agent
	}
	if body.Remove { // "Remove from Needs you": the row and the count only. No event, no release of held messages (the gate stays held while the prompt may be on screen), nothing typed (#14266)
		if st.WaitingSince.IsZero() { // Coral's own held notice, a sign-in or a launch prompt: no ask of the agent's, no time to tell one from the next, so a removal could hide a later one for ever
			errConflict(w, "Only a request the agent made itself can be removed from Needs you")
			return
		}
		removed, err := h.ss.SetWaitRemoved(r.Context(), sid, waitRequestKey(st))
		if err != nil {
			slog.Warn("could not record the Operator's removal of a wait", "session_id", sid, "error", err)
			errInternalServer(w, "Could not remove it. Try again.")
			return
		}
		if !removed {
			errConflict(w, "Dismiss it first: only a wait that is already dismissed and still waiting can be removed")
			return
		}
		h.kickFeedForRequestChange(sid, "request_resolved")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": true})
		return
	}
	// Every kind the same (permission, question, plan, an input prompt, an elicitation, a sign-in): the Operator's seeing it is kept per agent and request, so the row, the count and /api/needs-you agree
	// (#11946, #14203). The agent's own state is untouched and nothing is sent to it; its next request is its own.
	if err := h.ss.SetWaitIgnored(r.Context(), sid, waitRequestKey(st)); err != nil {
		slog.Warn("could not record the Operator's dismissal of a wait", "session_id", sid, "error", err) // the cause is logged, never sent: no database text in a response
		errInternalServer(w, "Could not dismiss it. Try again.")
		return
	}
	h.kickFeedForRequestChange(sid, "request_resolved")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": true, "hidden": true})
}
