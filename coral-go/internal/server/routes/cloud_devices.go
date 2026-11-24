package routes

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The device list at this computer (#19669 slice 5, coral-hub condition e): the person here sees the browsers and passkeys Coral Hub's owner trusts, lowers or removes any one, and lowers the mode new browsers start at. Every route here is local only: the dashboard on this computer and the signed command line, never the tunnel (never at any mode), never a paired browser, never a Hub sign-in.

type deviceRow struct {
	KID        string `json:"kid"`
	Label      string `json:"label"`
	Mode       string `json:"mode"`
	Origin     string `json:"origin"`
	Kind       string `json:"kind"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at,omitempty"`
}

type deviceList struct {
	WebMode     string      `json:"web_mode"`
	Devices     []deviceRow `json:"devices"`
	ClockNotice string      `json:"clock_notice,omitempty"`
}

// removedDeviceReply is the device list after a removal, plus (#20926) a plain word when ending the grants the device signed did not work: the device is gone, and this many grants are still live.
type removedDeviceReply struct {
	deviceList
	GrantsRevokeFailed bool `json:"grants_revoke_failed,omitempty"`
	GrantsStillLive    *int `json:"grants_still_live,omitempty"`
}

func (h *CloudHandler) deviceList(r *http.Request) (deviceList, error) {
	ctx := r.Context()
	out := deviceList{WebMode: h.ss.DeviceWebMode(ctx), Devices: []deviceRow{}}
	keys, err := h.ss.ListDeviceKeys(ctx)
	if err != nil {
		return out, err
	}
	for _, k := range keys {
		if k.RemovedAt != 0 {
			continue
		}
		out.Devices = append(out.Devices, deviceRow{KID: k.KID, Label: k.Label, Mode: k.Mode, Origin: k.Origin, Kind: k.Kind, CreatedAt: k.CreatedAt, LastUsedAt: k.LastUsedAt})
	}
	if mark, err := h.ss.ClockMark(ctx); err == nil && !mark.IsZero() && time.Now().Before(mark) {
		out.ClockNotice = sprintfClock(mark)
	}
	return out, nil
}

// TunnelDevices: GET /api/device-keys/list: the list Coral Hub's owner may see of the browsers and passkeys this computer trusts, for display only (#19971, coral-hub #252527, Security's ruling on #19959). It is in the tunnel table at Launch, owner only
// (OwnerRefuse), GET only. Each row is kid, label, mode, origin, kind, created_at and last_used_at: no public key, no web_mode and no clock_notice (those stay on the local list above). A listed row grants nothing: the computer
// verifies every signed message itself. A paired browser's own row is not answered here (it needs a caller stamp the tunnel does not give).
func (h *CloudHandler) TunnelDevices(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	out, err := h.deviceList(r)
	if err != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Devices []deviceRow `json:"devices"`
	}{out.Devices})
}

// TunnelLink: GET /api/device-keys/link: the link this request arrived on (lnk-<8 hex>), for Coral Hub's owner (#20903, coral-hub #20897), so the Hub can name it in the v3 text a browser signs. It is the connector's own stamp read from the request context, never from a body or query; nothing is stored. Owner only, Launch tier, read only. A local call has no link and gets 404.
func (h *CloudHandler) TunnelLink(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	v, ok := cloud.ViaFrom(r.Context())
	if !cloud.Tunneled(r) || !ok || !tunnel.ValidLinkID(v.LinkID) {
		errNotFound(w, "no link: this request did not come through a Hub")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Link string `json:"link"`
	}{v.LinkID})
}

// sprintfClock is the notice for a clock behind the last accepted device message: it says what the clock was compared with and how to fix it.
func sprintfClock(mark time.Time) string {
	return "This computer's clock is behind the last time it accepted a device message (" + mark.Local().Format("2006-01-02 15:04") + "). Set the clock right. If the clock is right and the old time was wrong, run: coral cloud devices clear-clock"
}

// Devices: GET /api/cloud/devices
func (h *CloudHandler) Devices(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	out, err := h.deviceList(r)
	if err != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SetDeviceWebMode: PUT /api/cloud/device-web-mode {"mode": "view"|"interact"|"launch"}: what the next browser paired from the link gets. A device already paired keeps its mode (lower it by itself).
func (h *CloudHandler) SetDeviceWebMode(w http.ResponseWriter, r *http.Request) {
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
	if err := h.ss.SetDeviceWebMode(r.Context(), body.Mode); err != nil {
		errBadRequest(w, "mode must be view, interact or launch")
		return
	}
	slog.Info("cloud: the mode for newly paired browsers was set here", "mode", body.Mode)
	out, err := h.deviceList(r)
	if err != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SetDeviceMode: PUT /api/cloud/devices/{kid}/mode {"mode": ...}: one device's mode, set here.
func (h *CloudHandler) SetDeviceMode(w http.ResponseWriter, r *http.Request) {
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
	kid := chi.URLParam(r, "kid")
	switch body.Mode {
	case "view", "interact", "launch":
	default:
		errBadRequest(w, "mode must be view, interact or launch")
		return
	}
	ctx := r.Context()
	if _, err := h.ss.ActiveDeviceKey(ctx, kid, time.Now()); err != nil {
		errNotFound(w, "No such device")
		return
	}
	if err := h.ss.SetDeviceMode(ctx, kid, body.Mode, "", time.Now()); err != nil {
		errInternalServer(w, "Could not change the device")
		return
	}
	slog.Info("cloud: a device's mode was set here", "kid", kid, "mode", body.Mode)
	out, err := h.deviceList(r)
	if err != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RemoveDevice: DELETE /api/cloud/devices/{kid}
func (h *CloudHandler) RemoveDevice(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	kid := chi.URLParam(r, "kid")
	ctx := r.Context()
	k, err := h.ss.ActiveDeviceKey(ctx, kid, time.Now())
	if err != nil {
		errNotFound(w, "No such device")
		return
	}
	if err := h.ss.RemoveDeviceKey(ctx, kid, "removed", time.Now()); err != nil && !errors.Is(err, store.ErrUnknownSigner) {
		errInternalServer(w, "Could not remove the device")
		return
	}
	// The person may also end the access this device signed (#20899): the list asks (DeviceSignedGrants) and says so with ?revoke_grants=1.
	var failed bool
	var stillLive *int
	if r.URL.Query().Get("revoke_grants") == "1" && h.bs != nil {
		before, cerr := h.bs.CountLiveGrantsSignedBy(ctx, kid, time.Now())
		n, gerr := h.bs.RevokeMemberGrantsSignedBy(ctx, kid, time.Now())
		if gerr != nil {
			slog.Warn("cloud: could not end the grants a removed device signed", "kid", kid, "error", gerr)
			failed = true
			if cerr == nil {
				left := before - n
				if left < 0 {
					left = 0
				}
				stillLive = &left
			}
		} else if n > 0 {
			slog.Info("cloud: grants ended with their device", "kid", kid, "count", n)
		}
	}
	slog.Info("cloud: device removed", "action", "removed-here", "kid", kid, "mode", k.Mode)
	out, lerr := h.deviceList(r)
	if lerr != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, removedDeviceReply{deviceList: out, GrantsRevokeFailed: failed, GrantsStillLive: stillLive})
}

// DeviceSignedGrants: GET /api/cloud/devices/{kid}/signed-grants: how many live grants of access this owner device signed, so removing it can offer to end them too (#20899). Local only, like the rest of the device list.
func (h *CloudHandler) DeviceSignedGrants(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	n := 0
	if h.bs != nil {
		var err error
		if n, err = h.bs.CountLiveGrantsSignedBy(r.Context(), chi.URLParam(r, "kid"), time.Now()); err != nil {
			errInternalServer(w, "Could not read the access this device gave")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{"live": n})
}

// ClearDevicesClock: POST /api/cloud/devices/clear-clock: the owner's reset after a clock jump (the mark becomes now).
func (h *CloudHandler) ClearDevicesClock(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	if err := h.ss.ClearClockMark(r.Context(), time.Now()); err != nil {
		errInternalServer(w, "Could not reset the clock mark")
		return
	}
	slog.Info("cloud: the device clock mark was reset here")
	out, err := h.deviceList(r)
	if err != nil {
		errInternalServer(w, "Could not read the device list")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
