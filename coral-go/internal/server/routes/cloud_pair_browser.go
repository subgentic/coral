package routes

import (
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
)

// Pair a browser to a computer that is already connected (#21880, design-21880.md). The person at this computer starts, allows and cancels it (local only, human input, never tunneled, no agent); the browser's own answer comes
// through the Hub on the one unsigned route, POST /api/device-keys/pair, whose only authority is the MAC over a secret that never reached the Hub.
//
//	POST   /api/cloud/pair-browser        -> the view (link, code, fingerprint)   start; replaces an earlier one
//	GET    /api/cloud/pair-browser        -> the view (the waiting browser, if any)
//	DELETE /api/cloud/pair-browser        -> the view                              cancel
//	POST   /api/cloud/pair-browser/allow  {"mode"?: "view"|"interact"|"launch"}     trust the waiting browser (view when absent)
//	POST   /api/cloud/pair-browser/deny   {}                                        refuse it

func (h *CloudHandler) pairBrowserHuman(w http.ResponseWriter, r *http.Request) (*cloud.Manager, bool) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return nil, false
	}
	if !humanInputCaller(r) {
		errForbidden(w, "Only the person at this computer can pair a browser")
		return nil, false
	}
	m := h.manager()
	if m == nil {
		errBadRequest(w, cloud.ErrNotConfigured.Error())
		return nil, false
	}
	return m, true
}

func pairBrowserErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, cloud.ErrPairBrowserNotLinked), errors.Is(err, cloud.ErrPairBrowserNoKey), errors.Is(err, cloud.ErrPairBrowserNothing),
		errors.Is(err, cloud.ErrPairBrowserBadMode), errors.Is(err, cloud.ErrPairBrowserModeAbove):
		errBadRequest(w, err.Error())
	default:
		errInternalServer(w, "Could not do that; try again")
	}
}

func pairNoStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

// PairBrowserStart: POST /api/cloud/pair-browser
func (h *CloudHandler) PairBrowserStart(w http.ResponseWriter, r *http.Request) {
	m, ok := h.pairBrowserHuman(w, r)
	if !ok {
		return
	}
	v, err := m.StartPairBrowser(r.Context())
	if err != nil {
		pairBrowserErr(w, err)
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, v)
}

// PairBrowserState: GET /api/cloud/pair-browser
func (h *CloudHandler) PairBrowserState(w http.ResponseWriter, r *http.Request) {
	m, ok := h.pairBrowserHuman(w, r)
	if !ok {
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, m.PairBrowserState())
}

// PairBrowserCancel: DELETE /api/cloud/pair-browser
func (h *CloudHandler) PairBrowserCancel(w http.ResponseWriter, r *http.Request) {
	m, ok := h.pairBrowserHuman(w, r)
	if !ok {
		return
	}
	m.CancelPairBrowser()
	pairNoStore(w)
	writeJSON(w, http.StatusOK, m.PairBrowserState())
}

// PairBrowserAllow: POST /api/cloud/pair-browser/allow {"mode"?}. The mode is the person's choice here, never taken from the Hub or the answer; absent is view.
func (h *CloudHandler) PairBrowserAllow(w http.ResponseWriter, r *http.Request) {
	m, ok := h.pairBrowserHuman(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "the body must be a JSON object")
		return
	}
	if err := m.AllowPairBrowser(r.Context(), body.Mode); err != nil {
		pairBrowserErr(w, err)
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, m.PairBrowserState())
}

// PairBrowserDeny: POST /api/cloud/pair-browser/deny
func (h *CloudHandler) PairBrowserDeny(w http.ResponseWriter, r *http.Request) {
	m, ok := h.pairBrowserHuman(w, r)
	if !ok {
		return
	}
	if err := m.DenyPairBrowser(); err != nil {
		pairBrowserErr(w, err)
		return
	}
	pairNoStore(w)
	writeJSON(w, http.StatusOK, m.PairBrowserState())
}

// DeviceKeyPair: POST /api/device-keys/pair {"user_code","label","kid","pk","mac"}: the browser's answer to a pairing the person started here, relayed by the Hub. Not device-signed (the browser has no key yet): the MAC over the
// secret the link's fragment carried is its only authority, and the route never reads a Hub user, owner or account header. Every refusal is the same status and body (no hold, another link, a bad MAC, a bad key), so it tells a
// prober nothing; a good answer is {"status":"pending"} until the person here allows it, then {"status":"ok","reply_mac","computer"} once, or {"status":"refused"} once. The kid is hashed from the key here: a body kid that is not that is refused.
func (h *CloudHandler) DeviceKeyPair(w http.ResponseWriter, r *http.Request) {
	m := h.manager()
	if m == nil {
		deviceReply(w, errors.New("no verifier"))
		return
	}
	var req struct {
		UserCode string `json:"user_code"`
		Label    string `json:"label"`
		KID      string `json:"kid"`
		PK       string `json:"pk"`
		MAC      string `json:"mac"`
	}
	if err := readDeviceBody(w, r, &req); err != nil {
		deviceMsgLimiter.failed("pair", time.Now())
		pairRefused(w)
		return
	}
	if !deviceMsgLimiter.allow("pair", time.Now()) {
		pairRefused(w)
		return
	}
	res, err := m.AnswerPairBrowser(arrivalLink(r), req.UserCode, req.Label, devicekey.PairingAnswer{V: 1, KID: req.KID, MAC: req.MAC, PK: req.PK})
	if err != nil {
		deviceMsgLimiter.failed("pair", time.Now())
		pairRefused(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	switch res.State {
	case "ok":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "reply_mac": base64.RawURLEncoding.EncodeToString(res.Reply), "computer": res.Computer})
	case "refused":
		writeJSON(w, http.StatusOK, map[string]string{"status": "refused"})
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
	}
}

// pairRefused is the one answer to every failed pairing answer.
func pairRefused(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"error":"pairing_refused"}`))
}
