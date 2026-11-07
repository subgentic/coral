package routes

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/subgentic/coral/internal/board"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
)

// keepFullAccessField is the row key that says a Codex agent keeps Full access across restarts. With codex_live_mode and codex_relaunch_narrows it says who runs with what access, so it is the
// Operator's alone: an agent's token never gets it (personTextFields) and neither does a Hub viewer (dropOwnerOnlyCodexFields) (#14061, Security's INFO on #14051).
const keepFullAccessField = "keep_full_access"

// dropOwnerOnlyCodexFields removes those three keys from the rows of a request that is not the Operator's: an agent's token, or a Hub viewer who is not the authentic owner.
func dropOwnerOnlyCodexFields(r *http.Request, rows []map[string]any) {
	if _, agent := VerifiedSession(r.Context()); !agent && !(cloud.Tunneled(r) && !hubOwnerRequest(r).owner) {
		return
	}
	for _, row := range rows {
		delete(row, "codex_live_mode")
		delete(row, "codex_relaunch_narrows")
		delete(row, keepFullAccessField)
		delete(row, permissionEffectiveField)
	}
}

// keepFullAccessType says which agents have the choice: the three CLIs whose launch builders apply it after the capabilities (#14061 Codex, #14085 Claude and agy).
func keepFullAccessType(agentType string) bool {
	return agentType == "codex" || agentType == "claude" || agentType == "agy"
}

// keepFullAccessForRelaunch says whether a relaunch of this Codex session runs with Full access whatever its capabilities and mode say (#14061, the Operator's "Keep Full access when this agent
// restarts"). newCaps is the capabilities the relaunched row will store: a relaunch that edits them is the person changing what the agent may do, so the choice does not apply (and is cleared
// when the row is replaced). The application is logged each time. A read failure means off: Full access is never granted on a guess.
func (h *SessionsHandler) keepFullAccessForRelaunch(ctx context.Context, agentType, sessionID, via string, oldCaps, newCaps *string) bool {
	if !keepFullAccessType(agentType) || sessionID == "" || h.ss == nil {
		return false
	}
	on, err := h.ss.KeepFullAccess(ctx, sessionID)
	if err != nil {
		slog.Warn("[keep-full-access] could not read the choice; starting without it", "session_id", sessionID, "error", err)
		return false
	}
	if !on {
		return false
	}
	if newCaps != nil && derefStr(newCaps) != derefStr(oldCaps) {
		return false
	}
	slog.Info("[keep-full-access] applied", "session_id", sessionID, "via", via)
	return true
}

// clearKeepFullAccess ends the choice and logs why. Used when a relaunch asks for something else on purpose.
func (h *SessionsHandler) clearKeepFullAccess(ctx context.Context, sessionID, why string) {
	if h.ss == nil {
		return
	}
	changed, err := h.ss.SetKeepFullAccess(ctx, sessionID, false)
	if err != nil {
		slog.Warn("[keep-full-access] could not clear the choice", "session_id", sessionID, "why", why, "error", err)
		return
	}
	if changed {
		slog.Info("[keep-full-access] cleared", "session_id", sessionID, "why", why)
	}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// KeepFullAccessOpt turns "Keep Full access when this agent restarts" on or off for one Codex agent (#14061). Operator only (refuseNonOwner: an agent's token and a Hub viewer are refused), the exact
// live target as for auto-sleep, and every change is logged.
func (h *SessionsHandler) KeepFullAccessOpt(w http.ResponseWriter, r *http.Request) {
	if agentCaller(r) { // the handler's own refusal, not only the identity table's: an agent never sets Full access for itself or another (QA, #14162)
		writeError(w, http.StatusForbidden, "forbidden_for_agent", "Only the Operator can set Full access.")
		return
	}
	if refuseNonOwner(w, r) {
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID string `json:"session_id"`
		AgentType string `json:"agent_type"`
		On        *bool  `json:"on"`
	}
	if err := decodeJSON(r, &body); err != nil || body.SessionID == "" || body.On == nil {
		errBadRequest(w, "session_id and on are required")
		return
	}
	// The exact target by id and type, as for the other per-agent switches, but a sleeping agent is a target too: the choice matters most for the wake that comes next.
	if _, perr := uuid.Parse(body.SessionID); perr != nil {
		errBadRequest(w, "invalid session_id")
		return
	}
	if !keepFullAccessType(body.AgentType) {
		errBadRequest(w, "Only a Claude, Codex or Antigravity agent has this setting.")
		return
	}
	ls, gerr := h.ss.GetLiveSession(r.Context(), body.SessionID)
	if gerr != nil {
		errInternalServer(w, "Agent metadata is temporarily unavailable; try again.")
		return
	}
	if ls == nil || ls.AgentType != body.AgentType {
		writeError(w, http.StatusNotFound, "", "live session not found")
		return
	}
	if *body.On && refuseHubSkip(w, r, h.ss, true) { // turning Full access on through the Hub needs the owner's switch and Launch mode, as any skip does; turning it off is always allowed (#14193)
		return
	}
	changed, err := h.ss.SetKeepFullAccessFrom(r.Context(), body.SessionID, *body.On, keepSourceOf(r))
	if err != nil {
		errInternalServer(w, "Could not save it. Try again.")
		return
	}
	if changed {
		note := "off"
		if *body.On {
			note = "on"
		}
		noteActivity(r, board.ActKeepFullAccess, "agent", name, "", "", note) // the Operator's click, in the Activity record (#14061, Security): written after the 2xx, for a person only
		if *body.On {
			slog.Info("[keep-full-access] set", "session_id", body.SessionID, "agent", name)
		} else {
			slog.Info("[keep-full-access] cleared", "session_id", body.SessionID, "agent", name, "why", "the person turned it off")
		}
	}
	h.kickWS()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "keep_full_access": *body.On})
}

// keepFullAccessRequestRefusal answers a launch or restart body that asks for the choice (the form's "Use Full access for this agent", #14085): only the Operator can (an agent's token, or a Hub user who
// is not the authentic owner, cannot start an agent with Full access: the same rule as the route), and only for the three CLIs. 0 and "" when it may go on.
func (h *SessionsHandler) keepFullAccessRequestRefusal(r *http.Request, agentType string) (int, string) {
	if agentCaller(r) || (cloud.Tunneled(r) && !hubOwnerRequest(r).owner) {
		return http.StatusForbidden, "Only the Operator can start an agent with Full access."
	}
	if !keepFullAccessType(agentType) {
		return http.StatusBadRequest, "Only a Claude, Codex or Antigravity agent has this setting."
	}
	return 0, ""
}

// storeKeepFullAccess stores the choice for a session the form just launched or restarted with it, logs it, and asks the recorder for the Activity row (a person's click only).
func (h *SessionsHandler) storeKeepFullAccess(ctx context.Context, r *http.Request, sessionID, name, via string) {
	changed, err := h.ss.SetKeepFullAccessFrom(ctx, sessionID, true, keepSourceOf(r))
	if err != nil {
		slog.Warn("[keep-full-access] could not store the choice made in the form", "session_id", sessionID, "via", via, "error", err)
		return
	}
	if changed {
		slog.Info("[keep-full-access] set", "session_id", sessionID, "agent", name, "via", via)
		noteActivity(r, board.ActKeepFullAccess, "agent", name, "", "", "on")
	}
}

// keepSourceOf is where a request that sets the choice came from: the hub when it came through the tunnel, else local. A hub-made choice ends with the hub's switch (ClearHubKeepFullAccess).
func keepSourceOf(r *http.Request) string {
	if cloud.Tunneled(r) {
		return store.KeepSourceHub
	}
	return store.KeepSourceLocal
}
