package routes

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Sign once (#21889): what the person at this computer decides about owner-certified browsers. Every route here is local only and human input (never tunneled, an agent token refused), like #21883's switch and the pair-a-browser
// routes: a Hub, an agent and a browser it certified cannot press Keep, change the setting, or remove the anchor.
//
//	GET    /api/cloud/owner-cert                     -> the setting, the anchor's fingerprint, every certified browser seen here and what the person decided
//	PUT    /api/cloud/owner-cert/accept {"mode"}     -> "off" (the default), "view", "interact" or "launch": the most a certified browser may act as here
//	POST   /api/cloud/owner-cert/devices/{kid}/keep {"mode"?}  -> Keep: the browser acts up to mode (interact when absent, never above what this computer allows the Hub)
//	DELETE /api/cloud/owner-cert/devices/{kid}       -> Remove: the browser is refused here from now on, whatever certificate it brings
//	DELETE /api/cloud/owner-cert/anchor              -> remove the anchor; every Keep is dropped

func (h *CloudHandler) certHuman(w http.ResponseWriter, r *http.Request) bool {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return false
	}
	if !humanInputCaller(r) {
		errForbidden(w, "Only the person at this computer can decide about certified browsers")
		return false
	}
	return true
}

type certDeviceRow struct {
	KID         string `json:"kid"`
	Label       string `json:"label"`    // the browser's own word (it comes from the certificate): shown here, never in a notice and never used to decide anything
	NamedBy     string `json:"named_by"` // always "browser": the UI shows it as "named by the browser" beside the fingerprint (Security, #21925)
	Fingerprint string `json:"fingerprint"`
	State       string `json:"state"` // "waiting" (never Kept: at view), "kept" or "removed"
	Mode        string `json:"mode"`  // what it acts as now: view until Keep
	FirstSeen   int64  `json:"first_seen"`
	LastSeen    int64  `json:"last_seen"`
}

type certAnchorRow struct {
	Fingerprint string `json:"fingerprint"`
	SetAt       int64  `json:"set_at"`
}

type certState struct {
	Accept  string          `json:"accept"` // off | view | interact | launch
	Anchor  *certAnchorRow  `json:"anchor"`
	Devices []certDeviceRow `json:"devices"`
}

func (h *CloudHandler) certState(r *http.Request) (certState, error) {
	ctx := r.Context()
	out := certState{Accept: "off", Devices: []certDeviceRow{}}
	if m, on := h.ss.OwnerCertAccept(ctx); on {
		out.Accept = m
	}
	a, has, err := h.ss.OwnerAnchorRow(ctx)
	if err != nil {
		return out, err
	}
	if has {
		out.Anchor = &certAnchorRow{Fingerprint: devicekey.FingerprintOfKID(a.KID), SetAt: a.SetAt}
	}
	ds, err := h.ss.ListCertifiedDevices(ctx)
	if err != nil {
		return out, err
	}
	for _, d := range ds {
		row := certDeviceRow{KID: d.KID, Label: d.Label, NamedBy: "browser", Fingerprint: devicekey.FingerprintOfKID(d.KID), State: "waiting", Mode: "view", FirstSeen: d.FirstSeen, LastSeen: d.LastSeen}
		switch {
		case d.DeniedAt != 0:
			row.State = "removed"
		case d.KeptMode != "":
			row.State, row.Mode = "kept", d.KeptMode
		}
		out.Devices = append(out.Devices, row)
	}
	return out, nil
}

// OwnerCertState: GET /api/cloud/owner-cert
func (h *CloudHandler) OwnerCertState(w http.ResponseWriter, r *http.Request) {
	if !h.certHuman(w, r) {
		return
	}
	out, err := h.certState(r)
	if err != nil {
		errInternalServer(w, "Could not read the certified browsers")
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, out)
}

// OwnerCertSetAccept: PUT /api/cloud/owner-cert/accept {"mode": "off"|"view"|"interact"|"launch"}
func (h *CloudHandler) OwnerCertSetAccept(w http.ResponseWriter, r *http.Request) {
	if !h.certHuman(w, r) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "mode is required")
		return
	}
	if err := h.ss.SetOwnerCertAccept(r.Context(), body.Mode); err != nil {
		errBadRequest(w, "mode must be off, view, interact or launch")
		return
	}
	slogCert("the setting for owner-certified browsers was set here", "mode", body.Mode)
	h.writeCertState(w, r)
}

// OwnerCertKeep: POST /api/cloud/owner-cert/devices/{kid}/keep {"mode"?}
func (h *CloudHandler) OwnerCertKeep(w http.ResponseWriter, r *http.Request) {
	if !h.certHuman(w, r) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "the body must be a JSON object")
		return
	}
	if body.Mode == "" {
		body.Mode = "interact"
	}
	md, ok := tunnel.ParseMode(body.Mode)
	if !ok || md > tunnel.TierLaunch || md.String() != body.Mode {
		errBadRequest(w, "mode must be view, interact or launch")
		return
	}
	if m := h.manager(); m != nil && md > m.MaxMode() {
		errBadRequest(w, "that mode is above what this computer allows Coral Hub")
		return
	}
	kid := chi.URLParam(r, "kid")
	if err := h.ss.KeepCertifiedDevice(r.Context(), kid, md.String(), time.Now()); err != nil {
		errBadRequest(w, "that browser is not waiting here")
		return
	}
	slogCert("a certified browser was kept here", "kid", kid, "mode", md.String())
	h.writeCertState(w, r)
}

// OwnerCertRemove: DELETE /api/cloud/owner-cert/devices/{kid}
func (h *CloudHandler) OwnerCertRemove(w http.ResponseWriter, r *http.Request) {
	if !h.certHuman(w, r) {
		return
	}
	kid := chi.URLParam(r, "kid")
	label := ""
	if d, ok, _ := h.ss.CertifiedDeviceRow(r.Context(), kid); ok {
		label = d.Label
	}
	if err := h.ss.DenyCertifiedDevice(r.Context(), kid, label, time.Now()); err != nil {
		errBadRequest(w, "not a browser id")
		return
	}
	slogCert("a certified browser was removed here", "kid", kid)
	h.writeCertState(w, r)
}

// OwnerCertRemoveAnchor: DELETE /api/cloud/owner-cert/anchor
func (h *CloudHandler) OwnerCertRemoveAnchor(w http.ResponseWriter, r *http.Request) {
	if !h.certHuman(w, r) {
		return
	}
	if err := h.ss.RemoveOwnerAnchor(r.Context()); err != nil {
		errInternalServer(w, "Could not remove the anchor")
		return
	}
	slogCert("the owner anchor was removed here")
	h.writeCertState(w, r)
}

func (h *CloudHandler) writeCertState(w http.ResponseWriter, r *http.Request) {
	out, err := h.certState(r)
	if err != nil {
		errInternalServer(w, "Could not read the certified browsers")
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, out)
}

func slogCert(msg string, args ...any) { slog.Info("cloud: "+msg, args...) }
