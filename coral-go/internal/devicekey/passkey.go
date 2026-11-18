package devicekey

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

const (
	maxCertField      = 2048 // each text field of a certificate, before it is decoded
	maxClientData     = 1024 // clientDataJSON, raw bytes (draft 10)
	maxDERSig         = 72
	passkeyMax        = 5
	passkeyCertWindow = 5 * time.Minute // both ways, not 24 h (draft 10)
	// challengePrefix is the domain prefix of the preimage.
	challengePrefix = "coral-hub/device-keys/2/passkey-cert"
)

// Certificate is a passkey-signed device certificate (#19669 slice 6, plan item 12, coral-hub Security's ruling #249073): a trusted passkey vouches for a new device key. It names no passkey: Coral tries each active one. The assertion fields are the browser's, base64url without padding, the signature DER ES256.
type Certificate struct {
	Label             string
	DevicePK          string // the new device's 65-byte point, base64url
	Ts                int64  // the signer's time, seconds
	AuthenticatorData string
	ClientDataJSON    string
	Signature         string
}

// Challenge is SHA-256 of the preimage: the prefix, 0x00, this computer's fingerprint (43 ASCII characters), 0x00, the label, 0x00, the device's 65 raw bytes, 0x00, ts as 8 bytes big-endian. The WebAuthn challenge is its base64url; Coral rebuilds it from its own fingerprint, so a certificate made for another computer fails.
func Challenge(computer, label string, devicePK []byte, ts int64) []byte {
	var t [8]byte
	binary.BigEndian.PutUint64(t[:], uint64(ts))
	h := sha256.New()
	h.Write([]byte(challengePrefix))
	h.Write([]byte{0})
	h.Write([]byte(computer))
	h.Write([]byte{0})
	h.Write([]byte(label))
	h.Write([]byte{0})
	h.Write(devicePK)
	h.Write([]byte{0})
	h.Write(t[:])
	return h.Sum(nil)
}

// HandleCertificate verifies a passkey certificate against Coral's own list and, only when every check has passed, records its nonce, touches the passkey and adds the new device at view. The origin and rp id come from the enrolled Hub (Verifier.HubOrigin), the passkey's key from the list, the time from now. A refusal changes nothing.
func (v *Verifier) HandleCertificate(ctx context.Context, c Certificate, now time.Time) (store.DeviceKey, error) {
	var none store.DeviceKey
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.Refuse != nil && v.Refuse() {
		return none, ErrListUnavailable
	}
	devRaw, ok := pointOK(c.DevicePK)
	if !ok || c.Label == "" || !LabelOK(c.Label) || c.Ts < 1 ||
		len(c.AuthenticatorData) > maxCertField || len(c.ClientDataJSON) > maxCertField || len(c.Signature) > maxCertField {
		return none, ErrBadForm
	}
	ad, e1 := b64.DecodeString(c.AuthenticatorData)
	cd, e2 := b64.DecodeString(c.ClientDataJSON)
	der, e3 := b64.DecodeString(c.Signature)
	if e1 != nil || e2 != nil || e3 != nil || len(cd) > maxClientData || len(der) > maxDERSig {
		return none, ErrBadForm
	}
	if err := v.Store.CheckClock(ctx, now); err != nil {
		return none, mapStoreErr(err)
	}
	ts := time.Unix(c.Ts, 0)
	if ts.Before(now.Add(-passkeyCertWindow)) || ts.After(now.Add(passkeyCertWindow)) {
		return none, ErrTsWindow
	}
	if !v.RefuseBefore.IsZero() && ts.Before(v.RefuseBefore) {
		return none, ErrBeforeStart
	}
	want := Challenge(v.Computer, c.Label, devRaw, c.Ts)
	if !v.assertionOK(ad, cd, want) {
		return none, ErrBadSignature
	}
	// No credential id is trusted: each active passkey (at most 5) is tried, and the one fixed code is bad_signature however it failed.
	msg := append(append([]byte{}, ad...), sum(cd)...)
	h := sha256.Sum256(msg)
	var pass store.DeviceKey
	found := false
	list, err := v.Store.ListDeviceKeys(ctx)
	if err != nil {
		return none, err
	}
	tried := 0
	for _, k := range list {
		if k.Kind != store.DeviceKindPasskey || tried >= passkeyMax {
			continue
		}
		if a, err := v.Store.ActiveDeviceKey(ctx, k.KID, now); err != nil || a.Kind != store.DeviceKindPasskey {
			continue
		}
		tried++
		if verifyDER(k.PK, h[:], der) {
			pass, found = k, true
			break
		}
	}
	if !found {
		return none, ErrBadSignature
	}
	nonce := b64.EncodeToString(want[:16]) // from the challenge hash: the same certificate is the same nonce
	if err := v.Store.NonceSeen(ctx, nonce, now); err != nil {
		return none, mapStoreErr(err)
	}
	devKID := b64.EncodeToString(sum(devRaw))
	if _, err := v.Store.ActiveDeviceKey(ctx, devKID, now); err == nil {
		return none, ErrBadForm
	} else if !errors.Is(err, store.ErrUnknownSigner) {
		return none, mapStoreErr(err) // a key on the removed list is refused, not added again
	}
	pm, ok := tunnel.ParseMode(pass.Mode) // the new device starts at view, never above the passkey's own mode
	if !ok || pm < tunnel.TierView {
		return none, ErrAboveSigner
	}
	if err := v.Store.RecordNonce(ctx, nonce, pass.KID, now, passkeyCertWindow); err != nil {
		return none, mapStoreErr(err)
	}
	if err := v.Store.TouchDeviceKey(ctx, pass.KID, now); err != nil {
		return none, err
	}
	k := store.DeviceKey{KID: devKID, PK: devRaw, Label: c.Label, Mode: tunnel.TierView.String(), Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice}
	if _, err := v.Store.AddDeviceKey(ctx, k, now); err != nil {
		return none, mapStoreErr(err)
	}
	return k, nil
}

func sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

// assertionOK checks the WebAuthn fields against Coral's own record: authenticatorData exactly 37 bytes with user present and verified (backup flags ignored, no attested or extension data), rp id hash the Hub's host, clientDataJSON strict (no duplicate keys, no cross-origin, no top origin), type webauthn.get, origin exactly the Hub's, challenge the one for this computer.
func (v *Verifier) assertionOK(ad, cd, challenge []byte) bool {
	u, err := url.Parse(v.HubOrigin)
	if err != nil || v.HubOrigin == "" || u.Scheme != "https" || u.Hostname() == "" || u.Path != "" || u.Port() != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if len(ad) != 37 || subtle.ConstantTimeCompare(ad[:32], sum([]byte(u.Hostname()))) != 1 {
		return false
	}
	if f := ad[32]; f&0x01 == 0 || f&0x04 == 0 || f&0xC0 != 0 { // UP and UV set; AT and ED not
		return false
	}
	m, ok := strictObject(cd)
	if !ok {
		return false
	}
	var typ, origin, ch string
	if json.Unmarshal(m["type"], &typ) != nil || typ != "webauthn.get" ||
		json.Unmarshal(m["origin"], &origin) != nil || origin != v.HubOrigin ||
		json.Unmarshal(m["challenge"], &ch) != nil {
		return false
	}
	if _, has := m["topOrigin"]; has {
		return false
	}
	if raw, has := m["crossOrigin"]; has && strings.TrimSpace(string(raw)) != "false" {
		return false
	}
	got, err := b64.DecodeString(ch)
	return err == nil && subtle.ConstantTimeCompare(got, challenge) == 1
}

// strictObject parses one JSON object whose top-level keys are all distinct, and nothing after it.
func strictObject(b []byte) (map[string]json.RawMessage, bool) {
	dec := json.NewDecoder(strings.NewReader(string(b)))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	m := map[string]json.RawMessage{}
	for dec.More() {
		t, err := dec.Token()
		k, isStr := t.(string)
		if err != nil || !isStr {
			return nil, false
		}
		if _, dup := m[k]; dup {
			return nil, false
		}
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return nil, false
		}
		m[k] = v
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return nil, false
	}
	if _, err := dec.Token(); err == nil || dec.More() {
		return nil, false // anything after the object
	}
	return m, true
}

// verifyDER checks a DER ES256 signature (what a browser's WebAuthn gives) over a SHA-256 digest with ecdsa.VerifyASN1: trailing bytes and anything over 72 bytes are refused, with no conversion to P1363.
func verifyDER(pk, digest, der []byte) bool {
	if len(pk) != 65 || len(der) > maxDERSig {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), pk) //nolint:staticcheck // a raw point; the curve check is in Unmarshal
	if x == nil {
		return false
	}
	return ecdsa.VerifyASN1(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, digest, der)
}
