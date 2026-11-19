package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/devicekey"
)

// The two device-signed routes (#19669 slice 7, wire format draft 11 at coral-hub lead/device-keys-2-1 526e3d78bb): the Hub forwards, unstamped, what a trusted browser signed, and this computer's verifier decides. The signature is the only authority here: the routes never read a Hub user, owner or account header (an owner claim with a bad signature is refused as one with none), and they grant owner authority nowhere else. A device message signs P1363 (exactly 64 bytes), a passkey certificate is DER; each route takes only its own form.

const (
	deviceMsgMaxBody  = 4096 // the Hub's own cap
	deviceMsgReplyMax = 1024
	deviceMsgPerMin   = 30 // this computer's own limit, whatever the Hub's
)

// deviceMsgLimit counts only the checks that FAILED, per claimed signer: a good message never uses the budget, so a flood of bad ones cannot delay a signed removal from another signer. The Hub forwards unstamped, so there is no source address to key on; the claimed kid (or "" when the body has none, or a shared "other" bucket once deviceMsgKeysMax kids are tracked) is the key.
type deviceMsgLimit struct {
	mu sync.Mutex
	by map[string]*deviceBucket
}

type deviceBucket struct {
	start time.Time
	n     int
}

const deviceMsgKeysMax = 256

func (l *deviceMsgLimit) bucket(key string, now time.Time) *deviceBucket {
	if l.by == nil {
		l.by = map[string]*deviceBucket{}
	}
	b, ok := l.by[key]
	if !ok {
		if len(l.by) >= deviceMsgKeysMax {
			for k, o := range l.by { // drop the buckets whose minute is over
				if now.Sub(o.start) >= time.Minute {
					delete(l.by, k)
				}
			}
		}
		if len(l.by) >= deviceMsgKeysMax {
			key = "other"
			if b, ok = l.by[key]; ok {
				return b
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

// claimedKID is the signer a message says it is from (no check): only a bucket key.
func claimedKID(body string) string {
	var m struct {
		KID string `json:"kid"`
	}
	if json.Unmarshal([]byte(body), &m) != nil || len(m.KID) > 64 {
		return ""
	}
	return m.KID
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
		deviceMsgLimiter.failed("", time.Now())
		deviceReply(w, err)
		return
	}
	key := claimedKID(req.Body)
	if !deviceMsgLimiter.allow(key, time.Now()) {
		deviceReply(w, errors.New("rate limited"))
		return
	}
	_, err := v.Handle(r.Context(), devicekey.Action(req.Action), []byte(req.Body), req.Sig, time.Now())
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
