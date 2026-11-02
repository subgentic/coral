package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// AutoSleepOpt is the Operator's per-agent switch for auto-sleep (#12111): off keeps the agent awake however long it is idle, on puts it back under the rule. Operator-only (an agent's
// token is refused: the route is in the identity census as b; through Coral Hub the owner's alone). It changes Coral's own record only: nothing is typed or killed.
// POST /api/sessions/live/{name}/auto-sleep  {"session_id": ..., "agent_type": ..., "off": true|false}
func (h *SessionsHandler) AutoSleepOpt(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID string `json:"session_id"`
		AgentType string `json:"agent_type"`
		Off       *bool  `json:"off"`
	}
	if err := decodeJSON(r, &body); err != nil || body.SessionID == "" || body.Off == nil {
		errBadRequest(w, "session_id and off are required")
		return
	}
	// The exact target, as for Send and dismiss-wait: a bare name could change another agent's setting (#3211).
	if _, status, message := h.validateExactLiveTarget(r.Context(), name, body.AgentType, body.SessionID, false); status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	if err := h.ss.SetAutoSleepOff(r.Context(), body.SessionID, *body.Off); err != nil {
		errInternalServer(w, "Could not save it. Try again.")
		return
	}
	h.kickWS()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "auto_sleep_off": *body.Off})
}
