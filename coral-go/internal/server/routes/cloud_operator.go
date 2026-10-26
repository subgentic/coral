package routes

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	setreg "github.com/subgentic/coral/internal/settings"
)

// HubOperatorDisabledSetting is the local owner opt-out "Don't let Coral Hub act as the
// Operator" (#3404). Off by default: a Coral Hub user at Interact or Launch acts as the
// Operator (task planning, cross-team posts, completing others' tasks), as before
// v1.4.18, with every use attributed to the validated Hub user. It is kept when the Hub
// link is removed. Local only: the hub can read it (GET /api/system/hub-operator, view
// tier) but never change it.
const HubOperatorDisabledSetting = "hub_operator_disabled"

func hubOperatorDisabled(settings map[string]string) bool {
	return setreg.Bool(settings, HubOperatorDisabledSetting)
}

// HubOperatorDisabled reports whether "Don't let Coral Hub act as the Operator" (#3404) is on in
// settings; it also refuses Sign in with Coral Hub (#3966).
func HubOperatorDisabled(settings map[string]string) bool { return hubOperatorDisabled(settings) }

// HubLinked reports whether this computer is linked to Coral Hub (enrolled, not revoked).
func (h *CloudHandler) HubLinked() bool { return h.hubLinked() }

func (h *CloudHandler) hubLinked() bool {
	if h.linked != nil {
		return h.linked()
	}
	m := h.manager()
	if m == nil {
		return false
	}
	switch m.Status().State {
	case cloud.StateConnected, cloud.StateConnecting, cloud.StateRetrying:
		return true
	}
	return false
}

// HubOperatorAllowed reports whether this tunnel request may act as the Operator: it
// carries the connector's own stamp, this server is linked to Coral Hub, and the owner
// has not turned on the opt-out. The tunnel's route table has already admitted the
// request at the effective mode (a View request never reaches a board write).
func (h *CloudHandler) HubOperatorAllowed(r *http.Request) bool {
	if !cloud.TunneledAuthentic(r) || !h.hubLinked() {
		return false
	}
	s, err := h.ss.GetSettings(r.Context())
	return err == nil && !hubOperatorDisabled(s)
}

// HubOperator: GET/PUT /api/system/hub-operator. On this computer, from the dashboard:
// {"disabled": bool} turns the opt-out on or off; the answer adds whether a Hub link exists and
// the recent Operator actions taken through Coral Hub. Through the tunnel only GET, read only,
// and only {"disabled"}.
func (h *CloudHandler) HubOperator(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		s, _ := h.ss.GetSettings(r.Context())
		off := hubOperatorDisabled(s)
		writeJSON(w, http.StatusOK, map[string]any{"disabled": off})
		return
	}
	if h.refuseCloud(w, r, allowDashboard) {
		return
	}
	if r.Method == http.MethodPut {
		if !requireJSON(w, r) {
			return
		}
		var body struct {
			Disabled *bool `json:"disabled"`
		}
		if err := decodeJSON(r, &body); err != nil || body.Disabled == nil {
			errBadRequest(w, "disabled (true or false) is required")
			return
		}
		off := *body.Disabled
		if err := h.ss.SetSetting(r.Context(), HubOperatorDisabledSetting, strconv.FormatBool(off)); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		slog.Info("[cloud] 'Don't let Coral Hub act as the Operator' changed on this computer", "disabled", off)
	}
	s, _ := h.ss.GetSettings(r.Context())
	off := hubOperatorDisabled(s)
	out := map[string]any{"disabled": off, "linked": h.hubLinked(), "recent_actions": []board.HubOperatorAction{}}
	if h.bs != nil {
		if recent, err := h.bs.RecentHubOperatorActions(r.Context(), 50); err == nil {
			out["recent_actions"] = recent
		}
	}
	writeJSON(w, http.StatusOK, out)
}
