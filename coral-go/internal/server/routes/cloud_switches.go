package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/cloud"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// applyMaxMode saves the cap and applies it: below Launch what the hub enabled auto-accept for ends, and a running tunnel learns the new mode. The error text is for the person.
func (h *CloudHandler) applyMaxMode(ctx context.Context, mode tunnel.Mode) error {
	if err := h.ss.SetSetting(ctx, MaxModeSetting, mode.String()); err != nil {
		return errors.New("Could not save the setting")
	}
	if mode < tunnel.TierLaunch {
		// Enabling auto-accept from the hub needs Launch: what it enabled ends.
		if _, err := h.ss.ClearHubAutoAccept(ctx, store.AutoAcceptModeLowered); err != nil {
			return errors.New("Could not turn off Coral Hub auto-accept")
		}
	}
	if m := h.manager(); m != nil {
		m.ModeChanged(ctx)
	}
	return nil
}

// SetMaxMode: PUT /api/cloud/max-mode {"mode": "view"|"interact"|"launch"}
func (h *CloudHandler) SetMaxMode(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "mode is required")
		return
	}
	mode, ok := tunnel.ParseMode(body.Mode)
	if !ok {
		errBadRequest(w, "mode must be view, interact or launch")
		return
	}
	if err := h.applyMaxMode(r.Context(), mode); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// SetRedactTokens: PUT /api/cloud/redact-tokens {"redact": bool}. Local dashboard and the
// signed command line only (never through the tunnel). It applies to the next reply.
func (h *CloudHandler) SetRedactTokens(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Redact *bool `json:"redact"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Redact == nil {
		errBadRequest(w, "redact is required")
		return
	}
	v := "true"
	if !*body.Redact {
		v = "false"
	}
	if err := h.ss.SetSetting(r.Context(), RedactTokensSetting, v); err != nil {
		errInternalServer(w, "Could not save the setting")
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// SetHubRelaunch: PUT /api/cloud/hub-relaunch {"allow": bool}. Local dashboard and the signed command line only (never through
// the tunnel): whether Coral Hub's owner may relaunch this Coral into an update it has staged (#5280).
func (h *CloudHandler) SetHubRelaunch(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Allow *bool `json:"allow"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Allow == nil {
		errBadRequest(w, "allow is required")
		return
	}
	if err := h.ss.SetSetting(r.Context(), HubRelaunchSetting, strconv.FormatBool(*body.Allow)); err != nil {
		errInternalServer(w, "Could not save the setting")
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// SetHubCrossTeam: PUT /api/cloud/hub-cross-team {"allow": bool}. Local dashboard and the signed command line only (never through the tunnel, any role): whether Coral Hub's owner may turn
// cross-team messaging and file sharing on or off for this computer's teams (#5572). Off refuses the Hub in both directions.
func (h *CloudHandler) SetHubCrossTeam(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Allow *bool `json:"allow"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Allow == nil {
		errBadRequest(w, "allow is required")
		return
	}
	if err := h.ss.SetSetting(r.Context(), HubCrossTeamSetting, strconv.FormatBool(*body.Allow)); err != nil {
		errInternalServer(w, "Could not save the setting")
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// SetAllowHubAutoAccept: PUT /api/cloud/allow-auto-accept {"allow": bool}. Local
// dashboard only (never through the tunnel). Off turns off every agent's
// auto-accept that the Cloud Hub enabled.
func (h *CloudHandler) SetAllowHubAutoAccept(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Allow *bool `json:"allow"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Allow == nil {
		errBadRequest(w, "allow is required")
		return
	}
	if err := h.applyAllowAutoAccept(r.Context(), *body.Allow); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// applyAllowAutoAccept saves this computer's switch (off ends every auto-accept the hub enabled) and records that it was changed here.
func (h *CloudHandler) applyAllowAutoAccept(ctx context.Context, allow bool) error {
	v := "true"
	if !allow {
		v = "false"
	}
	if err := h.ss.SetSetting(ctx, AllowHubAutoAcceptSetting, v); err != nil {
		return errors.New("Could not save the setting")
	}
	if !allow {
		if _, err := h.ss.ClearHubAutoAccept(ctx, store.AutoAcceptHubAllowOff); err != nil {
			return errors.New("Could not turn off Coral Hub auto-accept")
		}
	}
	h.recordAutoAcceptChange(ctx, "local", "")
	return nil
}

// hubAutoAcceptChange is who last changed the Coral Hub auto-accept switch and when (HubAutoAcceptChanged, #5840): By is "hub" (the Coral Hub owner, User the validated hub user) or "local"
// (this computer's Settings), At an RFC 3339 time (UTC).
type hubAutoAcceptChange struct {
	By   string `json:"by"`
	User string `json:"user,omitempty"`
	At   string `json:"at"`
}

// recordAutoAcceptChange stores who changed the switch, to show beside it. A failure is logged and does not undo the change.
func (h *CloudHandler) recordAutoAcceptChange(ctx context.Context, by, user string) hubAutoAcceptChange {
	c := hubAutoAcceptChange{By: by, User: user, At: time.Now().UTC().Format(time.RFC3339)}
	b, _ := json.Marshal(c)
	if err := h.ss.SetSetting(context.WithoutCancel(ctx), setreg.HubAutoAcceptChanged, string(b)); err != nil {
		slog.Warn("[cloud] could not record who changed the Coral Hub auto-accept switch", "error", err)
	}
	return c
}

// HubOwnerSetAutoAccept: POST /api/hub-auto-accept {"allow": bool} (#5840), Coral Hub's owner turning "Coral Hub can turn on auto-accept" on or off. The route table marks it owner-only for the
// hub (tunnel.OwnerHubOnly, Launch tier): refuseNonOwner refuses anyone but the account this computer is linked to, and a request that did not come through Coral Hub, with 403 owner_only
// before anything is read. The body is closed (exactly {"allow": true|false}, 64 bytes at most, no query). It sets the same setting as the Settings switch (PUT /api/cloud/allow-auto-accept);
// turning it off ends every auto-accept the hub had enabled, as that route does. The change is recorded on this computer (who, when: shown beside the switch), in the Operator-actions
// log and in the log.
func (h *CloudHandler) HubOwnerSetAutoAccept(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if refuseNonOwner(w, r) {
		return
	}
	id := hubOwnerRequest(r)
	if r.URL.RawQuery != "" {
		errBadRequest(w, textHubAutoAcceptBody)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 65))
	if err != nil || len(raw) > 64 {
		errBadRequest(w, textHubAutoAcceptBody)
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body struct {
		Allow *bool `json:"allow"`
	}
	if err := dec.Decode(&body); err != nil || body.Allow == nil || dec.More() {
		errBadRequest(w, textHubAutoAcceptBody)
		return
	}
	allow := *body.Allow
	v := "false"
	if allow {
		v = "true"
	}
	if err := h.ss.SetSetting(r.Context(), AllowHubAutoAcceptSetting, v); err != nil {
		errInternalServer(w, "Could not save the setting")
		return
	}
	ended := 0
	if !allow {
		n, err := h.ss.ClearHubAutoAccept(r.Context(), store.AutoAcceptHubAllowOff)
		if err != nil {
			errInternalServer(w, "Could not turn off Coral Hub auto-accept")
			return
		}
		ended = n
	}
	change := h.recordAutoAcceptChange(r.Context(), "hub", id.pseudo)
	recordHubOwnerAction(r.Context(), h.bs, id, r.Method, r.URL.Path+" allow="+v, "", http.StatusOK)
	slog.Info("[cloud] Coral Hub's owner set the Coral Hub auto-accept switch", "allow", allow, "auto_accepts_ended", ended, "hub_user", id.pseudo)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "allow_hub_auto_accept": allow, "auto_accepts_ended": ended, "changed_by": change})
}

const textHubAutoAcceptBody = `the body is {"allow": true} or {"allow": false} and nothing else (and no query)`

// refuseSystemSetting is refuseCloud's dashboard-only gate for Coral's own system settings
// (hub mode, restart, #3460): the same checks, with answers that point at this computer's
// dashboard rather than at `coral cloud connect`. With strict local auth an agent token is
// already refused by the identity observer (operatorOnlyRoutes).
func (h *CloudHandler) refuseSystemSetting(w http.ResponseWriter, r *http.Request) bool {
	const where = "This is set in the Coral dashboard on the computer running Coral"
	if cloud.Tunneled(r) {
		errForbidden(w, where+", not through Coral Hub")
		return true
	}
	if h.refusePeer(w, r, where+", as the user Coral runs as") {
		return true
	}
	if r.Header.Get(cloud.CLIAuthHeader) == "" && localDashboard(r) {
		return false
	}
	writeError(w, http.StatusForbidden, "local_dashboard_required", where+": open Settings there")
	return true
}

// HubMode: GET/PUT /api/system/hub-mode, on this computer only, from the dashboard
// (never through Coral Hub, never another local user). {"enabled": bool} saves the
// setting; the answer is {saved, running, forced, restart_required, can_restart}.
func (h *CloudHandler) HubMode(w http.ResponseWriter, r *http.Request) {
	if h.refuseSystemSetting(w, r) {
		return
	}
	if r.Method == http.MethodPut {
		if !requireJSON(w, r) {
			return
		}
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if err := decodeJSON(r, &body); err != nil || body.Enabled == nil {
			errBadRequest(w, "enabled (true or false) is required")
			return
		}
		if err := h.ss.SetSetting(r.Context(), HubModeSetting, strconv.FormatBool(*body.Enabled)); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		slog.Info("[hub] 'Run as a hub' changed on this computer; it applies at the next start", "enabled", *body.Enabled)
	}
	s, _ := h.ss.GetSettings(r.Context())
	saved := setreg.Bool(s, HubModeSetting)
	want := saved || h.HubModeForced
	writeJSON(w, http.StatusOK, map[string]any{
		"saved": saved, "running": h.HubModeRunning, "forced": h.HubModeForced,
		"restart_required": want != h.HubModeRunning, "can_restart": h.Restart != nil,
	})
}

// RestartServer: POST /api/system/restart, on this computer only, from the dashboard,
// and only where this process can restart itself (the desktop apps); 409 elsewhere.
func (h *CloudHandler) RestartServer(w http.ResponseWriter, r *http.Request) {
	if h.refuseSystemSetting(w, r) {
		return
	}
	if !requireJSON(w, r) {
		return
	}
	if !humanInputCaller(r) {
		writeError( // a person only: never an agent with forged browser headers (#3634)
			w, http.StatusForbidden, "operator_only", "only the Operator can restart Coral")
		return
	}
	if h.Restart == nil {
		writeError(w, http.StatusConflict, "restart_unavailable", "This Coral can't restart itself: quit it and start it again")
		return
	}
	if err := h.Restart(); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	slog.Info("[system] restarting at the dashboard's request")
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}
