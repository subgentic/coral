package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
)

// The two device-signed routes (#19669 slice 7, wire format draft 11 at coral-hub lead/device-keys-2-1 526e3d78bb): the Hub forwards, unstamped, what a trusted browser signed, and this computer's verifier decides. The signature is the only authority here: the routes never read a Hub user, owner or account header (an owner claim with a bad signature is refused as one with none), and they grant owner authority nowhere else. A device message signs P1363 (exactly 64 bytes), a passkey certificate is DER; each route takes only its own form.

const (
	deviceMsgMaxBody  = 4096 // the Hub's own cap
	deviceMsgReplyMax = 1024
	deviceMsgPerMin   = 30 // this computer's own limit, whatever the Hub's
)

// deviceMsgLimit counts only the checks that FAILED, per signer bucket: a good message never uses the budget. The Hub forwards unstamped, so there is no source address; the bucket is the claimed kid only when that kid is on the device list (each listed kid has its own, so a flood of invented kids cannot push a real signer out), and every unlisted kid shares one "unknown" bucket. What remains: a flood that claims a LISTED kid with bad signatures can spend that signer's budget for a minute (the signature cannot be checked for free before it is charged).
type deviceMsgLimit struct {
	mu sync.Mutex
	by map[string]*deviceBucket
}

type deviceBucket struct {
	start time.Time
	n     int
}

const deviceBucketsMax = 64 // listed kids are at most 10 active; expired buckets are dropped past this

func (l *deviceMsgLimit) bucket(key string, now time.Time) *deviceBucket {
	if l.by == nil {
		l.by = map[string]*deviceBucket{}
	}
	b, ok := l.by[key]
	if !ok {
		if len(l.by) >= deviceBucketsMax {
			for k, o := range l.by {
				if now.Sub(o.start) >= time.Minute {
					delete(l.by, k)
				}
			}
		}
		b = &deviceBucket{start: now}
		l.by[key] = b
	}
	if now.Sub(b.start) >= time.Minute {
		b.start, b.n = now, 0
	}
	return b
}

// allow reports whether this signer still has failed-check budget.
func (l *deviceMsgLimit) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.bucket(key, now).n < deviceMsgPerMin
}

// failed charges one failed check to the signer.
func (l *deviceMsgLimit) failed(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.bucket(key, now).n++
}

var deviceMsgLimiter deviceMsgLimit

// limiterKey is the bucket a message's failures are charged to: its claimed kid when that kid is on the device list, "unknown" for any other kid, "form" when the body names none.
func limiterKey(r *http.Request, v *devicekey.Verifier, body string, now time.Time) string {
	link := arrivalLink(r)
	var m struct {
		KID string `json:"kid"`
	}
	if json.Unmarshal([]byte(body), &m) != nil || m.KID == "" || len(m.KID) > 64 {
		return link + "|form"
	}
	if _, err := v.Store.ActiveDeviceKey(r.Context(), m.KID, now); err != nil {
		return link + "|unknown"
	}
	return link + "|" + m.KID
}

// arrivalLink is the Hub link this request came through, from the computer's own link stamp (never from the body or a header the caller set), or "" for a request that came by no link. It is what the verifier holds a bound key to,
// and part of every failed-check bucket, so one link's flood cannot spend another link's budget (#20514 SHOULD).
func arrivalLink(r *http.Request) string {
	if v, ok := cloud.ViaFrom(r.Context()); ok {
		return v.LinkID
	}
	return ""
}

// deviceReply writes {"error": code} (the closed list) or {"status":"ok"}, at most 1 KB, and nothing else.
func deviceReply(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err == nil {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		return
	}
	code := devicekey.ReplyCode(err)
	status := http.StatusForbidden
	switch code {
	case devicekey.CodeInternal, "list_unavailable", "clock_back", "nonce_store_full", "before_start":
		status = http.StatusServiceUnavailable
	case "bad_form", "bad_mode", "ts_window":
		status = http.StatusBadRequest
	case "nonce_repeat", "key_limit":
		status = http.StatusConflict
	}
	b, _ := json.Marshal(map[string]string{"error": code})
	if len(b) > deviceMsgReplyMax {
		b = []byte(`{"error":"internal"}`)
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// deviceVerifier is the manager's one verifier, or nil when there is none (no manager or no computer key).
func (h *CloudHandler) deviceVerifier() *devicekey.Verifier {
	m := h.manager()
	if m == nil {
		return nil
	}
	return m.NewDeviceVerifier(h.ss)
}

// readDeviceBody reads at most 4096 bytes of a JSON object and refuses anything over, a trailing value or an unknown field.
func readDeviceBody(w http.ResponseWriter, r *http.Request, into any) error {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, deviceMsgMaxBody))
	if err != nil {
		return devicekey.ErrBadForm
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(into) != nil || dec.More() {
		return devicekey.ErrBadForm
	}
	return nil
}

// DeviceKeyMessage: POST /api/device-keys/message {"action", "body" (the canonical JSON as signed, a string), "sig" (P1363, 86 characters)}.
func (h *CloudHandler) DeviceKeyMessage(w http.ResponseWriter, r *http.Request) {
	v := h.deviceVerifier()
	if v == nil {
		deviceReply(w, errors.New("no verifier"))
		return
	}
	// list_unavailable first, before anything of the request is read.
	if v.Refuse != nil && v.Refuse() {
		deviceReply(w, devicekey.ErrListUnavailable)
		return
	}
	var req struct {
		Action string `json:"action"`
		Body   string `json:"body"`
		Sig    string `json:"sig"`
	}
	if err := readDeviceBody(w, r, &req); err != nil {
		deviceMsgLimiter.failed(arrivalLink(r)+"|form", time.Now())
		deviceReply(w, err)
		return
	}
	key := limiterKey(r, v, req.Body, time.Now())
	if !deviceMsgLimiter.allow(key, time.Now()) {
		deviceReply(w, errors.New("rate limited"))
		return
	}
	_, err := v.HandleOn(r.Context(), arrivalLink(r), devicekey.Action(req.Action), []byte(req.Body), req.Sig, time.Now())
	if err != nil {
		deviceMsgLimiter.failed(key, time.Now())
	}
	deviceReply(w, err)
}

// DeviceKeyCertificate: POST /api/device-keys/certificate (a passkey's certificate for a new device; the signature is DER).
func (h *CloudHandler) DeviceKeyCertificate(w http.ResponseWriter, r *http.Request) {
	v := h.deviceVerifier()
	if v == nil {
		deviceReply(w, errors.New("no verifier"))
		return
	}
	if v.Refuse != nil && v.Refuse() {
		deviceReply(w, devicekey.ErrListUnavailable)
		return
	}
	var req struct {
		Label             string `json:"label"`
		DevicePK          string `json:"device_pk"`
		Ts                int64  `json:"ts"`
		AuthenticatorData string `json:"authenticator_data"`
		ClientDataJSON    string `json:"client_data_json"`
		Signature         string `json:"signature"`
	}
	if err := readDeviceBody(w, r, &req); err != nil {
		deviceMsgLimiter.failed("cert", time.Now())
		deviceReply(w, err)
		return
	}
	if !deviceMsgLimiter.allow("cert", time.Now()) {
		deviceReply(w, errors.New("rate limited"))
		return
	}
	_, err := v.HandleCertificate(r.Context(), devicekey.Certificate{Label: req.Label, DevicePK: req.DevicePK, Ts: req.Ts,
		AuthenticatorData: req.AuthenticatorData, ClientDataJSON: req.ClientDataJSON, Signature: req.Signature}, time.Now())
	if err != nil {
		deviceMsgLimiter.failed("cert", time.Now())
	}
	deviceReply(w, err)
}
