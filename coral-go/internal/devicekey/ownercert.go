package devicekey

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Sign once (#21889, design v4 and Security's conditions): the person's anchor passkey, learned only at a pairing, signs one owner certificate per browser, with no computer in it. A browser that holds a valid one may sign
// the closed list of content kinds on every computer that listed the anchor, but only after the person at that computer pressed Keep for it. This file holds the certificate (parse, challenge, checks); the relayed path (relayed.go)
// calls it for a signer that is not in the computer's list.

var (
	// ErrCertExpired is code cert_expired: the certificate is outside its validity (expired or not yet valid). Its sentence says it is not valid now and to check the clock.
	ErrCertExpired = errors.New("cert_expired")
	// ErrCertEpoch is code cert_epoch: the certificate's epoch is below the highest this computer has seen for its anchor.
	ErrCertEpoch = errors.New("cert_epoch")
	// ErrCertNotAllowed is code cert_not_allowed: the computer does not accept this certified browser for this: the setting is off, the kind is not on the closed list, the browser was not Kept, or the person removed it.
	ErrCertNotAllowed = errors.New("cert_not_allowed")
)

const (
	ownerCertPrefix = "coral-hub/device-keys/4/owner-cert"
	// CertHeaderMax is the most bytes of the Coral-Device-Cert and Coral-Device-Revoke headers (design v4): one value each, never empty.
	CertHeaderMax = 6144
	certMaxAbove  = 24 * time.Hour     // the longest life of a certificate whose max_mode is above view
	certMaxView   = 7 * 24 * time.Hour // and at view
	certSkew      = 5 * time.Minute    // how far ahead of this computer's clock a not_before may be
	certCacheMax  = 256
)

// OwnerCert is an owner certificate: the anchor passkey vouches for a browser's device key. The assertion fields are the browser's WebAuthn answer.
type OwnerCert struct {
	OwnerKID          string // the anchor's kid, 43 characters
	Label             string
	DevicePK          string // the browser's 65-byte point, base64url
	MaxMode           string // view, interact or launch
	NotBefore         int64
	NotAfter          int64
	Epoch             int64
	AuthenticatorData string
	ClientDataJSON    string
	Signature         string
}

// OwnerCertChallenge is SHA-256 of the preimage: the prefix, 0x00, owner_kid, 0x00, label, 0x00, the device's 65 raw bytes, 0x00, max_mode, 0x00, not_before, not_after and epoch as 8 bytes big-endian each. No computer is in it:
// the same certificate is good on every computer that listed the anchor.
func OwnerCertChallenge(c OwnerCert, devicePK []byte) []byte {
	h := sha256.New()
	h.Write([]byte(ownerCertPrefix))
	for _, f := range [][]byte{[]byte(c.OwnerKID), []byte(c.Label), devicePK, []byte(c.MaxMode)} {
		h.Write([]byte{0})
		h.Write(f)
	}
	h.Write([]byte{0})
	for _, n := range []int64{c.NotBefore, c.NotAfter, c.Epoch} {
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		h.Write(b[:])
	}
	return h.Sum(nil)
}

var certKeys = []string{"owner_kid", "label", "device_pk", "max_mode", "not_before", "not_after", "epoch", "authenticator_data", "client_data_json", "signature"}

// ParseOwnerCert reads a Coral-Device-Cert header value: base64url of one JSON object with exactly the keys of the certificate. Over CertHeaderMax, not base64url, not strict JSON, an unknown or repeated key, a wrong type
// or a field that does not fit is bad_form, and nothing of it is kept.
func ParseOwnerCert(header string) (OwnerCert, error) {
	var c OwnerCert
	if header == "" || len(header) > CertHeaderMax {
		return c, ErrBadForm
	}
	raw, err := b64.DecodeString(header)
	if err != nil {
		return c, ErrBadForm
	}
	m, ok := strictObject(raw)
	if !ok || len(m) != len(certKeys) {
		return c, ErrBadForm
	}
	str := func(k string) (string, bool) {
		var s string
		r, has := m[k]
		return s, has && json.Unmarshal(r, &s) == nil
	}
	num := func(k string) (int64, bool) {
		r, has := m[k]
		if !has || !plainInt(string(bytes.TrimSpace(r))) {
			return 0, false
		}
		n, err := strconv.ParseInt(string(bytes.TrimSpace(r)), 10, 64)
		return n, err == nil
	}
	ok = true
	for _, f := range []struct {
		k string
		p *string
	}{{"owner_kid", &c.OwnerKID}, {"label", &c.Label}, {"device_pk", &c.DevicePK}, {"max_mode", &c.MaxMode}, {"authenticator_data", &c.AuthenticatorData}, {"client_data_json", &c.ClientDataJSON}, {"signature", &c.Signature}} {
		var got bool
		*f.p, got = str(f.k)
		ok = ok && got
	}
	for _, f := range []struct {
		k string
		p *int64
	}{{"not_before", &c.NotBefore}, {"not_after", &c.NotAfter}, {"epoch", &c.Epoch}} {
		var got bool
		*f.p, got = num(f.k)
		ok = ok && got
	}
	if !ok || c.NotBefore < 1 || c.NotAfter <= c.NotBefore || c.Epoch < 0 || c.Epoch > 9_999_999_999_999 {
		return OwnerCert{}, ErrBadForm
	}
	if _, ok := fixedB64(c.OwnerKID, 43, 32); !ok {
		return OwnerCert{}, ErrBadForm
	}
	if len(c.AuthenticatorData) > maxCertField || len(c.ClientDataJSON) > maxCertField || len(c.Signature) > maxCertField || !LabelOK(c.Label) {
		return OwnerCert{}, ErrBadForm
	}
	md, mok := tunnel.ParseMode(c.MaxMode)
	if !mok || md > tunnel.TierLaunch || c.MaxMode != md.String() {
		return OwnerCert{}, ErrBadForm
	}
	life := time.Duration(c.NotAfter-c.NotBefore) * time.Second
	if (md > tunnel.TierView && life > certMaxAbove) || life > certMaxView {
		return OwnerCert{}, ErrBadForm
	}
	return c, nil
}

// OwnerStore is what the certified-signer path needs of internal/store. A Verifier with none accepts no certificate.
type OwnerStore interface {
	OwnerAnchorRow(ctx context.Context) (store.OwnerAnchor, bool, error)
	OwnerEpoch(ctx context.Context, ownerKID string) (int64, error)
	SeenCertifiedDevice(ctx context.Context, kid, ownerKID, label string, now time.Time) (store.CertifiedDevice, bool, error)
	CertifiedDeviceRow(ctx context.Context, kid string) (store.CertifiedDevice, bool, error)
	RaiseOwnerEpoch(ctx context.Context, ownerKID string, epoch int64, now time.Time) error
	RecordCertNonce(ctx context.Context, nonce, anchorKID, deviceKID string, now time.Time, window time.Duration) error
}

// certCache remembers, by the hash of a certificate header, that its assertion verified (until the certificate's not_after) or that it did not (for a minute), so a certificate is checked once and garbage is cheap.
type certCache struct {
	mu sync.Mutex
	m  map[[32]byte]certVerdict
}

type certVerdict struct {
	ok    bool
	until time.Time
}

func (c *certCache) get(h [32]byte, now time.Time) (ok, known bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, has := c.m[h]
	if !has || !now.Before(v.until) {
		delete(c.m, h)
		return false, false
	}
	return v.ok, true
}

func (c *certCache) put(h [32]byte, ok bool, until time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil || len(c.m) >= certCacheMax {
		c.m = map[[32]byte]certVerdict{} // bounded: a full cache is emptied, never grown
	}
	c.m[h] = certVerdict{ok, until}
}

// certified is what a verified certificate gives the relayed path.
type certified struct {
	Signer store.DeviceKey // a row never stored: the browser's key at its effective mode
	Anchor store.OwnerAnchor
	Dev    store.CertifiedDevice
	First  bool
}

// certifiedSignerOf checks the certificate for the request's signer kid. The order is cheap first and one fixed code per class: the setting, form and size, the key's kid, the anchor, the window, the epoch, the deny list, and only
// then (after the request's own signature, which the caller checks with the returned key) the P-256 assertion, cached by the header's hash. A refusal changes nothing.
func (v *Verifier) certifiedSignerOf(ctx context.Context, kid, header string, now time.Time) (certified, OwnerCert, error) {
	var none certified
	if v.Owner == nil || v.CertCap == nil {
		return none, OwnerCert{}, ErrCertNotAllowed
	}
	capMode, on := v.CertCap()
	if !on {
		return none, OwnerCert{}, ErrCertNotAllowed
	}
	c, err := ParseOwnerCert(header)
	if err != nil {
		return none, c, err
	}
	devRaw, ok := pointOK(c.DevicePK)
	if !ok || b64.EncodeToString(sum(devRaw)) != kid {
		return none, c, ErrBadForm
	}
	anchor, has, err := v.Owner.OwnerAnchorRow(ctx)
	if err != nil {
		return none, c, err
	}
	if !has || anchor.KID != c.OwnerKID {
		return none, c, ErrBadSignature // an unlisted owner reads like any bad signature
	}
	if now.Add(certSkew).Before(time.Unix(c.NotBefore, 0)) || !now.Before(time.Unix(c.NotAfter, 0)) {
		return none, c, ErrCertExpired
	}
	cur, err := v.Owner.OwnerEpoch(ctx, anchor.KID)
	if err != nil {
		return none, c, err
	}
	if c.Epoch < cur {
		return none, c, ErrCertEpoch
	}
	dev, known, err := v.Owner.CertifiedDeviceRow(ctx, kid)
	if err != nil {
		return none, c, err
	}
	if known && dev.DeniedAt != 0 {
		return none, c, ErrCertNotAllowed
	}
	mode := tunnel.TierView
	if known && dev.OwnerKID == anchor.KID && dev.KeptMode != "" {
		if km, ok := tunnel.ParseMode(dev.KeptMode); ok {
			mode = min(km, certMode(c), capMode)
		}
	}
	signer := store.DeviceKey{KID: kid, PK: devRaw, Label: c.Label, Mode: mode.String(), Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner, ViaPasskey: anchor.KID}
	return certified{Signer: signer, Anchor: anchor, Dev: dev}, c, nil
}

func certMode(c OwnerCert) tunnel.Mode { m, _ := tunnel.ParseMode(c.MaxMode); return m }

// assertionVerified runs (or recalls) the anchor's WebAuthn assertion over the certificate. Called only after the request's own signature held.
func (v *Verifier) assertionVerified(header string, c OwnerCert, anchor store.OwnerAnchor, now time.Time) bool {
	h := sha256.Sum256([]byte(header))
	if ok, known := v.certs.get(h, now); known {
		return ok
	}
	ok := v.checkAssertion(c, anchor)
	if ok {
		v.certs.put(h, true, time.Unix(c.NotAfter, 0))
	} else {
		v.certs.put(h, false, now.Add(time.Minute))
	}
	return ok
}

func (v *Verifier) checkAssertion(c OwnerCert, anchor store.OwnerAnchor) bool {
	devRaw, ok := pointOK(c.DevicePK)
	if !ok {
		return false
	}
	return v.anchorAssertion(OwnerCertChallenge(c, devRaw), c.AuthenticatorData, c.ClientDataJSON, c.Signature, anchor)
}

// anchorAssertion verifies the anchor's WebAuthn assertion (authenticator data, client data, DER signature, all base64url) over challenge.
func (v *Verifier) anchorAssertion(challenge []byte, adS, cdS, sigS string, anchor store.OwnerAnchor) bool {
	ad, e1 := b64.DecodeString(adS)
	cd, e2 := b64.DecodeString(cdS)
	der, e3 := b64.DecodeString(sigS)
	if e1 != nil || e2 != nil || e3 != nil || len(cd) > maxClientData || len(der) > maxDERSig {
		return false
	}
	if !v.assertionOK(ad, cd, challenge) {
		return false
	}
	msg := append(append([]byte{}, ad...), sum(cd)...)
	d := sha256.Sum256(msg)
	return verifyDER(anchor.PK, d[:], der)
}

// CertifiedKinds is the closed list of relayed kinds a certified browser may sign (Security Q2): the content kinds. Every other kind, admin or grant or link, is refused cert_not_allowed, and a kind added later is not on it until it is listed here.
var CertifiedKinds = map[Kind]bool{
	SendToAgent: true, BoardPost: true, TrustPreview: true, GuideRoster: true,
	DailyKnowledgeTeam: true, DailyKnowledgeAutoApply: true, DailyKnowledgeAccept: true, DailyKnowledgeRevert: true,
}

// certifiedAuthorizer wraps the relayed authorizer for a certified signer: the kind must be on the closed list and the route's tier must not exceed the browser's effective mode (view until Keep, so nothing above a read), then
// the ordinary rules apply (the owner pair and the kind's own route).
func certifiedAuthorizer(base func(Relayed, store.DeviceKey) error) func(Relayed, store.DeviceKey) error {
	return func(m Relayed, signer store.DeviceKey) error {
		if !CertifiedKinds[m.Kind] {
			return ErrCertNotAllowed
		}
		sm, ok := tunnel.ParseMode(signer.Mode)
		if !ok || tunnel.Classify(m.Method, RoutePath(m.Path), "") > sm {
			return ErrCertNotAllowed
		}
		return base(m, signer)
	}
}

// CertSeenLine is the Verifier.CertSeen that writes the audit line: the browser's kid (a public hash), the mode it acts at and whether this computer saw it first, never a label or a key.
func CertSeenLine(lg *slog.Logger) func(first bool, dev store.CertifiedDevice, mode string) {
	return func(first bool, dev store.CertifiedDevice, mode string) {
		if lg == nil || !first {
			return // only the first sight is a line: every later request is the same browser
		}
		lg.Info("cloud: a browser certified by the anchor passkey was seen here for the first time", "kid", dev.KID, "owner", dev.OwnerKID, "mode", mode)
	}
}

// FingerprintOfKID is the display fingerprint of a key from its kid (the kid is the base64url SHA-256 of the key, and DisplayFingerprint is the first 16 base32 characters of that same hash), for a row that keeps no key bytes.
func FingerprintOfKID(kid string) string {
	h, ok := fixedB64(kid, 43, 32)
	if !ok {
		return ""
	}
	e := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(h)[:16]
	return e[0:4] + "-" + e[4:8] + "-" + e[8:12] + "-" + e[12:16]
}

const ownerRevokePrefix = "coral-hub/device-keys/4/owner-revoke"

// OwnerRevoke is an epoch statement: the anchor passkey says every certificate below Epoch is void.
type OwnerRevoke struct {
	OwnerKID          string
	Epoch             int64
	AuthenticatorData string
	ClientDataJSON    string
	Signature         string
}

// OwnerRevokeChallenge is SHA-256 of the prefix, 0x00, owner_kid, 0x00 and the epoch as 8 bytes big-endian. No computer is in it, so one statement raises the epoch on every computer that listed the anchor.
func OwnerRevokeChallenge(r OwnerRevoke) []byte {
	h := sha256.New()
	h.Write([]byte(ownerRevokePrefix))
	h.Write([]byte{0})
	h.Write([]byte(r.OwnerKID))
	h.Write([]byte{0})
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(r.Epoch))
	h.Write(b[:])
	return h.Sum(nil)
}

var revokeKeys = []string{"owner_kid", "epoch", "authenticator_data", "client_data_json", "signature"}

// ParseOwnerRevoke reads a Coral-Device-Revoke header value: base64url of one strict JSON object with exactly the revoke keys. Anything else is bad_form.
func ParseOwnerRevoke(header string) (OwnerRevoke, error) {
	var r OwnerRevoke
	if header == "" || len(header) > CertHeaderMax {
		return r, ErrBadForm
	}
	raw, err := b64.DecodeString(header)
	if err != nil {
		return r, ErrBadForm
	}
	m, ok := strictObject(raw)
	if !ok || len(m) != len(revokeKeys) {
		return r, ErrBadForm
	}
	ok = true
	for _, f := range []struct {
		k string
		p *string
	}{{"owner_kid", &r.OwnerKID}, {"authenticator_data", &r.AuthenticatorData}, {"client_data_json", &r.ClientDataJSON}, {"signature", &r.Signature}} {
		rm, has := m[f.k]
		ok = ok && has && json.Unmarshal(rm, f.p) == nil
	}
	en, has := m["epoch"]
	t := string(bytes.TrimSpace(en))
	n, perr := strconv.ParseInt(t, 10, 64)
	if !ok || !has || !plainInt(t) || perr != nil || n < 0 || n > 9_999_999_999_999 {
		return OwnerRevoke{}, ErrBadForm
	}
	r.Epoch = n
	if _, ok := fixedB64(r.OwnerKID, 43, 32); !ok || len(r.AuthenticatorData) > maxCertField || len(r.ClientDataJSON) > maxCertField || len(r.Signature) > maxCertField {
		return OwnerRevoke{}, ErrBadForm
	}
	return r, nil
}

// applyRevoke applies an epoch statement that rode on a request whose own signature already held. Cheap first: form and size, the listed anchor, the epoch against the stored one (equal is nothing to do, lower is cert_epoch,
// more than store.EpochStepCap above is bad_form), and only then the P-256 assertion. It raises the stored epoch for the anchor and nothing else. It works whether or not this computer accepts certified browsers: revoking is never refused for a setting.
func (v *Verifier) applyRevoke(ctx context.Context, header string, now time.Time) error {
	if v.Owner == nil {
		return ErrCertNotAllowed
	}
	r, err := ParseOwnerRevoke(header)
	if err != nil {
		return err
	}
	anchor, has, err := v.Owner.OwnerAnchorRow(ctx)
	if err != nil {
		return err
	}
	if !has || anchor.KID != r.OwnerKID {
		return ErrBadSignature
	}
	cur, err := v.Owner.OwnerEpoch(ctx, anchor.KID)
	if err != nil {
		return err
	}
	switch {
	case r.Epoch < cur:
		return ErrCertEpoch
	case r.Epoch == cur:
		return nil
	case r.Epoch-cur > store.EpochStepCap:
		return ErrBadForm
	}
	if !v.anchorAssertion(OwnerRevokeChallenge(r), r.AuthenticatorData, r.ClientDataJSON, r.Signature, anchor) {
		return ErrBadSignature
	}
	switch err := v.Owner.RaiseOwnerEpoch(ctx, anchor.KID, r.Epoch, now); {
	case errors.Is(err, store.ErrEpochLower):
		return ErrCertEpoch
	case errors.Is(err, store.ErrEpochJump):
		return ErrBadForm
	default:
		return err
	}
}
