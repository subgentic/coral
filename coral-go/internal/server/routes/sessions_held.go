// The held automated messages of a live agent, and Send now (#7554): the Operator's way to deliver what the gate holds when its judgment of the agent is wrong. Operator-only (an agent's token is refused, so one
// agent cannot push text into another), never through the Hub, and a list that carries no message text.

package routes

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/ptymanager"
)

// heldRow is one held message as the list says it: who sent it, since when and why it waits.
type heldRow struct {
	ID     string `json:"id"`
	What   string `json:"what"`
	Since  string `json:"since"`
	Reason string `json:"reason"`
}

// ListHeld lists what is held for one live agent.
// GET /api/sessions/live/{name}/held?agent_type=..&session_id=..
func (h *SessionsHandler) ListHeld(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if _, status, message := h.validateExactLiveTarget(r.Context(), name, r.URL.Query().Get("agent_type"), r.URL.Query().Get("session_id"), false); status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	rows := []heldRow{}
	for _, m := range ptymanager.HeldMessages(name) {
		rows = append(rows, heldRow{ID: m.ID, What: m.What, Since: m.Since.UTC().Format(time.RFC3339), Reason: m.Reason})
	}
	writeJSON(w, http.StatusOK, map[string]any{"held": rows})
}

// SendHeldNow types the held messages of one live agent at once: the one named by id, or all of them when id is empty. The agent may be in the middle of a turn: the text is typed into its input box then.
// POST /api/sessions/live/{name}/held/send  {"agent_type":..,"session_id":..,"id":""}
func (h *SessionsHandler) SendHeldNow(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		AgentType string `json:"agent_type"`
		SessionID string `json:"session_id"`
		ID        string `json:"id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if _, status, message := h.validateExactLiveTarget(r.Context(), name, body.AgentType, body.SessionID, false); status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	res, err := ptymanager.SendHeldNow(r.Context(), name, body.ID)
	if errors.Is(err, ptymanager.ErrSendNowBusy) {
		writeError(w, http.StatusConflict, "held_busy", "this agent's held messages are being delivered right now; try again in a moment")
		return
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	out := map[string]any{"ok": true, "sent": res.Sent, "held_again": res.Again, "dropped": res.Gone, "left": res.Left}
	if res.Prompt != "" {
		out["prompt_open"] = true // a prompt or menu is open on the agent's terminal: nothing was typed into it
	}
	if res.Draft {
		out["draft_in_box"] = true // the agent's input box holds text that is not Coral's: nothing was added to it (#7579)
	}
	writeJSON(w, http.StatusOK, out)
}
