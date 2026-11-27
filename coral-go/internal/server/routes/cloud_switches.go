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
		h.clearHubKeepFullAccess(ctx, "the hub's mode was lowered below Launch")
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

// SetHubRequireTrustedDevice: PUT /api/cloud/hub-require-trusted-device {"require": bool}. The person at this computer only: the dashboard or the signed command line, never through the tunnel and never an agent (its session token is refused). Turning it on is refused while this
// computer has no active trusted device, since no Hub action could then pass (#21883). Every change is logged with who made it.
func (h *CloudHandler) SetHubRequireTrustedDevice(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(store.SessionTokenHeader) != "" {
		errForbidden(w, "Only the person at this computer can change this")
		return
	}
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Require *bool `json:"require"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Require == nil {
		errBadRequest(w, "require is required")
		return
	}
	if *body.Require {
		keys, err := h.ss.ListDeviceKeys(r.Context())
		if err != nil {
			errInternalServer(w, "Could not read the trusted devices")
			return
		}
		active := false
		for _, k := range keys {
			if k.RemovedAt == 0 && k.Kind == store.DeviceKindDevice && k.Origin == store.DeviceOriginPairing { // a key added without proof never counts: a broken-into Hub could have planted it
				active = true
			}
		}
		if !active {
			writeError(w, http.StatusConflict, "no_trusted_device", "Pair a trusted device first (one made with the pairing code, not added through the Hub): with none, every Hub action would be refused")
			return
		}
	}
	if hubRequireEnv() && !*body.Require {
		writeError(w, http.StatusConflict, "set_by_environment", "This is on because "+HubRequireTrustedDeviceEnv+"=1 was set when Coral started")
		return
	}
	if err := h.ss.SetSetting(r.Context(), HubRequireTrustedDeviceSetting, strconv.FormatBool(*body.Require)); err != nil {
		errInternalServer(w, "Could not save the setting")
		return
	}
	slog.Info("[hub] require a trusted device for Hub actions changed", "on", *body.Require, "by", "this computer", "from", r.RemoteAddr)
	writeJSON(w, http.StatusOK, h.status())
}

// SetHubDropboxShare: PUT /api/cloud/hub-dropbox-share {"allow": bool}. Local dashboard and the signed command line only (never through the tunnel, any role): whether Coral Hub's owner may send a file the person pressed Share on
// to the Dropbox connected on the Hub (#16109). Off by default.
func (h *CloudHandler) SetHubDropboxShare(w http.ResponseWriter, r *http.Request) {
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
	if err := h.ss.SetSetting(r.Context(), HubDropboxShareSetting, strconv.FormatBool(*body.Allow)); err != nil {
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
		h.clearHubKeepFullAccess(ctx, "the hub's auto-accept switch was turned off")
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

// HubOwnerSetAutoAccept: POST /api/hub-auto-accept {"allow": bool} (#5840), Coral Hub's owner turning "Allow Hub auto-accept" on or off. The route table marks it owner-only for the
// hub (tunnel.OwnerHubOnly, Launch tier): refuseNonOwner refuses anyone but the account this computer is linked to, and a request that did not come through Coral Hub, with 403 owner_only
// before anything is read. The body is closed (exactly {"allow": true|false}, 64 bytes at most; the query is none, or exactly allow=true or allow=false saying the same as the body, #20882). It sets the same setting as the Settings switch (PUT /api/cloud/allow-auto-accept);
// turning it off ends every auto-accept the hub had enabled, as that route does. The change is recorded on this computer (who, when: shown beside the switch), in the Operator-actions
// log and in the log.
func (h *CloudHandler) HubOwnerSetAutoAccept(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if refuseNonOwner(w, r) {
		return
	}
	id := hubOwnerRequest(r)
	query := r.URL.RawQuery // compared as the raw text: the signature covers the received URI
	if query != "" && query != "allow=true" && query != "allow=false" {
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
	if query != "" && query != "allow="+strconv.FormatBool(allow) {
		errBadRequest(w, textHubAutoAcceptBody) // a query that says another value than the body is refused, never merged
		return
	}
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
		h.clearHubKeepFullAccess(r.Context(), "the hub's auto-accept switch was turned off by its owner")
	}
	change := h.recordAutoAcceptChange(r.Context(), "hub", id.pseudo)
	recordHubOwnerAction(r.Context(), h.bs, id, r.Method, r.URL.Path+" allow="+v, "", http.StatusOK)
	slog.Info("[cloud] Coral Hub's owner set the Coral Hub auto-accept switch", "allow", allow, "auto_accepts_ended", ended, "hub_user", id.pseudo)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "allow_hub_auto_accept": allow, "auto_accepts_ended": ended, "changed_by": change})
}

const textHubAutoAcceptBody = `the body is {"allow": true} or {"allow": false} and nothing else (and, when a request carries a signature, the same value as ?allow=true or ?allow=false)`

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
	if same, supported := h.sameUser(r); supported && !same {
		writeError(w, http.StatusForbidden, "other_user", where+", as the user Coral runs as")
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

// clearHubKeepFullAccess ends every Keep Full access choice the hub made when the hub's switch goes off or its mode is lowered, as ClearHubAutoAccept ends what the hub enabled: Full access
// through the hub needs the switch, so a choice the hub made ends with it. A choice made locally stays (#14193). Logged with how many.
func (h *CloudHandler) clearHubKeepFullAccess(ctx context.Context, why string) {
	n, err := h.ss.ClearHubKeepFullAccess(ctx)
	if err != nil {
		slog.Warn("[keep-full-access] could not end the choices the hub made", "why", why, "error", err)
		return
	}
	if n > 0 {
		slog.Info("[keep-full-access] cleared", "why", why, "choices_ended", n)
	}
}
