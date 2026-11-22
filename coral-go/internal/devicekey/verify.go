package devicekey

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log/slog"
	"math/big"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The refusal codes of design page section 4. Each is a distinct, non-secret error whose text is the code.
var (
	ErrWrongComputer   = errors.New("wrong_computer")
	ErrTsWindow        = errors.New("ts_window")
	ErrBeforeStart     = errors.New("before_start")
	ErrClockBack       = errors.New("clock_back")
	ErrUnknownSigner   = errors.New("unknown_signer")
	ErrSignerRemoved   = errors.New("signer_removed")
	ErrBadSignature    = errors.New("bad_signature")
	ErrSignerBootstrap = errors.New("signer_bootstrap")
	ErrSignerNoProof   = errors.New("signer_no_proof")
	ErrBadMode         = errors.New("bad_mode")
	ErrTopMode         = errors.New("top_mode")
	ErrAboveSigner     = errors.New("above_signer")
	ErrSelfTarget      = errors.New("self_target")
	ErrTargetBootstrap = errors.New("target_bootstrap")
	// ErrListUnavailable: the device list could not be cleared on a new enrollment, so the old account's keys may still be in it: every signed message is refused, nothing is applied and no nonce is spent, until a clear works (coral-hub Security, #19717). A fixed code: it says nothing of the list.
	ErrListUnavailable = errors.New("list_unavailable")
	ErrUnknownTarget   = errors.New("unknown_target")
	ErrNonceRepeat     = errors.New("nonce_repeat")
	ErrNonceStoreFull  = errors.New("nonce_store_full")
	ErrKeyLimit        = errors.New("key_limit")
)

const (
	shortWindow = 5 * time.Minute   // approve-device and raise-mode
	longWindow  = 24 * time.Hour    // trust-passkey and remove-device
	aheadSkew   = 5 * time.Minute   // how far ahead of the computer's own clock a ts may be
	topMode     = tunnel.TierLaunch // only the computer's owner sets this; a signed message never can
)

// Store is what the verifier needs of internal/store.
type Store interface {
	ActiveDeviceKey(ctx context.Context, kid string, now time.Time) (store.DeviceKey, error)
	AddDeviceKey(ctx context.Context, k store.DeviceKey, now time.Time) (bool, error)
	RemoveDeviceKey(ctx context.Context, kid, reason string, now time.Time) error
	SetDeviceMode(ctx context.Context, kid, mode string, now time.Time) error
	TouchDeviceKey(ctx context.Context, kid string, now time.Time) error
	RecordNonce(ctx context.Context, nonce, kid string, now time.Time, window time.Duration) error
	NonceSeen(ctx context.Context, nonce string, now time.Time) error
	CheckClock(ctx context.Context, now time.Time) error
	WasRemoved(ctx context.Context, kid string) (bool, error)
	ListDeviceKeys(ctx context.Context) ([]store.DeviceKey, error)
}

// Verifier checks a signed step-2 message against Coral's own device list and applies it. It trusts nothing the Hub says: the signer's key and mode come from the list, the time from the clock passed in.
type Verifier struct {
	Store    Store
	Computer string // this computer's fingerprint: a body for any other is refused
	// RefuseBefore, when set, refuses every message whose ts is earlier. Coral sets it to its start time plus the window when the nonce store could not be read at start (design page v4 section 4, `before_start`).
	RefuseBefore time.Time

	// HubOrigin is the Hub address this computer is configured with, its Manager HubURL (https://host, no path; set by Coral, never read from a request): a passkey certificate's origin must equal it and its rp id is its host. Empty refuses every certificate.
	HubOrigin string

	// Refuse, when set, is asked first of all: while it returns true (a device-key clear is pending) every message is refused with ErrListUnavailable before anything of it is read.
	Refuse func() bool

	// Audit, when set, is called after each applied message (M3, #20514) with the signer's kid, the target's, and the mode the target has now (for a removal, the mode it had).
	Audit func(a Action, signerKID, targetKID, targetMode string)
	// Notice, when set, is called after an applied approve-device, raise-mode or trust-passkey with what the owner must be shown: who signed, the key it concerns by its fingerprint, and where the message came from.
	Notice func(Notice)
	// AuditCert, when set, is called after a passkey certificate added a device: the passkey's kid, the new device's kid and its mode (never a label or key bytes).
	AuditCert func(passkeyKID, deviceKID, mode string)

	mu sync.Mutex // one message at a time: the nonce check and the apply are not racing each other
}

// windowFor is how old a message's ts may be. A message that came through a Hub link has five minutes whatever its action (M6, #20514: the plan's window for every relayed kind); one that did not (a local call) keeps the step-2 windows.
func windowFor(a Action, arrivedLink string) time.Duration {
	if arrivedLink != "" || a == ApproveDevice || a == RaiseMode {
		return shortWindow
	}
	return longWindow
}

// Handle verifies one message and, only when every check has passed, records its nonce, touches the signer and applies it. The order is the cheap, secret-free checks first, the signature, then authority; a refusal at any step
// changes nothing. sig is the P1363 signature, base64url without padding.
func (v *Verifier) Handle(ctx context.Context, a Action, body []byte, sig string, now time.Time) (Message, error) {
	return v.HandleOn(ctx, "", a, body, sig, now)
}

// HandleOn is Handle for a message that arrived on the Hub link arrivedLink, taken from this computer's own stamp ("" for one that came by no link). A signer whose row carries a link (M1, #20514) is held to it: the
// message must have arrived on that link, and it acts only inside the signer's (link, Hub label) pair. A signer marked as the owner's (store.PairOwner, set where the computer made the key) is held to neither; a signer with no pair at all is refused.
func (v *Verifier) HandleOn(ctx context.Context, arrivedLink string, a Action, body []byte, sig string, now time.Time) (Message, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.Refuse != nil && v.Refuse() {
		return Message{}, ErrListUnavailable
	}
	m, err := Parse(a, body)
	if err != nil {
		return Message{}, err
	}
	if m.Computer != v.Computer {
		return Message{}, ErrWrongComputer
	}
	ts := time.Unix(m.Ts, 0)
	if ts.Before(now.Add(-windowFor(a, arrivedLink))) || ts.After(now.Add(aheadSkew)) {
		return Message{}, ErrTsWindow
	}
	if !v.RefuseBefore.IsZero() && ts.Before(v.RefuseBefore) {
		return Message{}, ErrBeforeStart
	}
	if err := v.Store.CheckClock(ctx, now); err != nil {
		return Message{}, mapStoreErr(err)
	}
	signer, err := v.Store.ActiveDeviceKey(ctx, m.KID, now)
	if err != nil {
		return Message{}, mapStoreErr(err)
	}
	if signer.Kind != store.DeviceKindDevice { // a passkey signs with WebAuthn (slice 6), not with this
		return Message{}, ErrUnknownSigner
	}
	if !verifyP1363(signer.PK, SigningInput(a, body), sig) {
		return Message{}, ErrBadSignature
	}
	owner, bound := signer.PairState()
	if !owner && !bound { // a pair that is missing or half a marker fails closed
		return Message{}, ErrOutsidePair
	}
	if bound && arrivedLink != signer.Link {
		return Message{}, ErrWrongLink
	}
	// The signature is good: from here the signer is who it says. A replay is answered nonce_repeat before anything about the list or the mode is said.
	if err := v.Store.NonceSeen(ctx, m.Nonce, now); err != nil {
		return Message{}, mapStoreErr(err)
	}
	// Authority next, read from Coral's own list.
	target, targetMode, err := v.authorize(ctx, m, signer, now)
	if err != nil {
		return Message{}, err
	}
	if err := v.Store.RecordNonce(ctx, m.Nonce, m.KID, now, windowFor(a, arrivedLink)); err != nil {
		return Message{}, mapStoreErr(err)
	}
	if err := v.Store.TouchDeviceKey(ctx, m.KID, now); err != nil {
		return Message{}, err
	}
	if err := v.apply(ctx, m, signer, target, targetMode, now); err != nil {
		return m, err
	}
	v.afterApply(m, signer, target, targetMode)
	return m, nil
}

// Notice is what the owner is told when a signed message added or raised a key (M4): never a label's meaning, only the fingerprint (the same grouping the pairing screen shows) and the names the computer itself recorded.
type Notice struct {
	Action      Action
	SignerKID   string
	SignerLabel string
	TargetKID   string
	Fingerprint string // of the target key, from this computer's own reading of the key, never a Hub field
	Label       string
	Mode        string
	Link        string
	HubUser     string
}

// keyFingerprint is the fingerprint the owner is shown for a key, read from its own bytes.
func keyFingerprint(pk []byte) string { return DisplayFingerprint(pk) }

func (v *Verifier) afterApply(m Message, signer, target store.DeviceKey, mode tunnel.Mode) {
	targetKID, tmode := m.TargetKID, mode.String()
	switch m.Action {
	case RemoveDevice:
		tmode = target.Mode
	case TrustPasskey:
		raw, _ := b64.DecodeString(m.PasskeyPK)
		s := sha256.Sum256(raw)
		targetKID, tmode = base64.RawURLEncoding.EncodeToString(s[:]), tunnel.TierView.String()
	}
	if v.Audit != nil {
		v.Audit(m.Action, m.KID, targetKID, tmode)
	}
	if v.Notice == nil || m.Action == RemoveDevice {
		return
	}
	n := Notice{Action: m.Action, SignerKID: m.KID, SignerLabel: signer.Label, TargetKID: targetKID, Label: m.Label, Mode: tmode, Link: signer.Link, HubUser: signer.HubUser}
	switch m.Action {
	case ApproveDevice:
		raw, _ := b64.DecodeString(m.TargetPK)
		n.Fingerprint = keyFingerprint(raw)
	case TrustPasskey:
		raw, _ := b64.DecodeString(m.PasskeyPK)
		n.Fingerprint = keyFingerprint(raw)
	case RaiseMode:
		n.Label, n.Fingerprint = target.Label, keyFingerprint(target.PK)
	}
	v.Notice(n)
}

func mapStoreErr(err error) error {
	switch {
	case errors.Is(err, store.ErrUnknownSigner):
		return ErrUnknownSigner
	case errors.Is(err, store.ErrSignerRemoved):
		return ErrSignerRemoved
	case errors.Is(err, store.ErrClockBack):
		return ErrClockBack
	case errors.Is(err, store.ErrNonceRepeat):
		return ErrNonceRepeat
	case errors.Is(err, store.ErrNonceStoreFull):
		return ErrNonceStoreFull
	case errors.Is(err, store.ErrKeyLimit):
		return ErrKeyLimit
	}
	return err
}

// authorize applies the rules of who may do what. It returns the target row for raise and remove and the parsed target mode for approve and raise.
func (v *Verifier) authorize(ctx context.Context, m Message, signer store.DeviceKey, now time.Time) (store.DeviceKey, tunnel.Mode, error) {
	var none store.DeviceKey
	if signer.ViaPasskey != "" && !(m.Action == RemoveDevice && m.TargetKID == m.KID) { // a device a passkey certified acts only on itself (M5)
		return none, 0, ErrSignerNoProof
	}
	switch m.Action {
	case ApproveDevice, RaiseMode, TrustPasskey:
		if signer.Origin == store.DeviceOriginBootstrap {
			return none, 0, ErrSignerBootstrap
		}
	}
	switch m.Action {
	case ApproveDevice, TrustPasskey:
		if signer.Origin == store.DeviceOriginNoProof {
			return none, 0, ErrSignerNoProof
		}
	}
	var mode tunnel.Mode
	if m.Action == ApproveDevice || m.Action == RaiseMode {
		var ok bool
		if mode, ok = tunnel.ParseMode(m.Mode); !ok {
			return none, 0, ErrBadMode
		}
		if mode >= topMode { // never the top mode, whoever signs
			return none, 0, ErrTopMode
		}
		if m.TargetKID == m.KID { // never the device itself
			return none, 0, ErrSelfTarget
		}
		sm, ok := tunnel.ParseMode(signer.Mode) // the signer's mode from the list, never from the body
		if !ok || mode > sm {
			return none, 0, ErrAboveSigner
		}
	}
	if m.Action == ApproveDevice { // a kid already listed is refused, not spent as a no-op; a removed or expired one may be paired again
		if _, err := v.Store.ActiveDeviceKey(ctx, m.TargetKID, now); err == nil {
			return none, 0, ErrBadForm
		} else if !errors.Is(err, store.ErrUnknownSigner) && !errors.Is(err, store.ErrSignerRemoved) {
			return none, 0, err
		} else if errors.Is(err, store.ErrSignerRemoved) { // one a person removed is not paired again by a message; one that only expired may be
			if gone, werr := v.Store.WasRemoved(ctx, m.TargetKID); werr != nil {
				return none, 0, werr
			} else if gone {
				return none, 0, ErrBadForm
			}
		}
	}
	var target store.DeviceKey
	if m.Action == RaiseMode || m.Action == RemoveDevice {
		var err error
		if target, err = v.Store.ActiveDeviceKey(ctx, m.TargetKID, now); err != nil {
			if errors.Is(err, store.ErrUnknownSigner) || errors.Is(err, store.ErrSignerRemoved) {
				return none, 0, ErrUnknownTarget
			}
			return none, 0, err
		}
		if o, _ := signer.PairState(); !o && (target.Link != signer.Link || target.HubUser != signer.HubUser) { // acts only inside the signer's own pair; the owner's key acts on any
			return none, 0, ErrOutsidePair
		}
		if m.Action == RemoveDevice && m.TargetKID != m.KID { // anyone may remove itself; another device only by a pairing signer strictly above its mode
			switch signer.Origin {
			case store.DeviceOriginBootstrap:
				return none, 0, ErrSignerBootstrap
			case store.DeviceOriginNoProof:
				return none, 0, ErrSignerNoProof
			}
			sm, ok := tunnel.ParseMode(signer.Mode)
			tm, tok := tunnel.ParseMode(target.Mode)
			if !ok || !tok || tm > sm || (tm == sm && sm < topMode) { // never a peer at the signer's own mode: only a device above the target removes it (at the top mode, which only the owner sets at the computer, a launch device may remove another)
				return none, 0, ErrAboveSigner
			}
		}
		if m.Action == RaiseMode {
			if target.Origin == store.DeviceOriginBootstrap { // stays capped until a real pairing
				return none, 0, ErrTargetBootstrap
			}
			// The target's current mode, read from the list: never above the signer's, and a raise goes strictly up (lowering is removing and pairing again, or the owner at the computer).
			tm, ok := tunnel.ParseMode(target.Mode)
			sm, sok := tunnel.ParseMode(signer.Mode)
			if !ok || !sok || tm > sm {
				return none, 0, ErrAboveSigner
			}
			if mode <= tm {
				return none, 0, ErrBadMode
			}
		}
	}
	return target, mode, nil
}

func (v *Verifier) apply(ctx context.Context, m Message, signer, target store.DeviceKey, mode tunnel.Mode, now time.Time) error {
	switch m.Action {
	case ApproveDevice:
		raw, _ := b64.DecodeString(m.TargetPK)
		_, err := v.Store.AddDeviceKey(ctx, store.DeviceKey{KID: m.TargetKID, PK: raw, Label: m.Label, Mode: mode.String(), Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: signer.Link, HubUser: signer.HubUser, ApprovedBy: signer.KID}, now)
		return mapStoreErr(err)
	case TrustPasskey:
		raw, _ := b64.DecodeString(m.PasskeyPK)
		s := sha256.Sum256(raw)
		_, err := v.Store.AddDeviceKey(ctx, store.DeviceKey{KID: base64.RawURLEncoding.EncodeToString(s[:]), PK: raw, Label: m.Label, Mode: tunnel.TierView.String(), Origin: store.DeviceOriginPairing, Kind: store.DeviceKindPasskey, Link: signer.Link, HubUser: signer.HubUser, ApprovedBy: signer.KID}, now)
		return mapStoreErr(err)
	case RaiseMode:
		return mapStoreErr(v.Store.SetDeviceMode(ctx, m.TargetKID, mode.String(), now))
	case RemoveDevice:
		return mapStoreErr(v.Store.RemoveDeviceKey(ctx, m.TargetKID, store.DeviceRemoved, now))
	}
	return ErrBadForm
}

// verifyP1363 checks an ECDSA P-256 / SHA-256 signature of exactly 64 bytes (r then s), base64url without padding, against a raw 65-byte point.
func verifyP1363(pk []byte, msg []byte, sig string) bool {
	raw, ok := fixedB64(sig, 86, 64)
	if !ok || len(pk) != 65 {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), pk) //nolint:staticcheck // a raw point; the curve check is in Unmarshal
	if x == nil {
		return false
	}
	h := sha256.Sum256(msg)
	return ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, h[:], new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:]))
}

// AuditLine is the Verifier.Audit that writes the removal to the log: the kids (public hashes) and the mode, never a label or a message.
func AuditLine(lg *slog.Logger) func(a Action, signerKID, targetKID, targetMode string) {
	return func(a Action, signerKID, targetKID, targetMode string) {
		lg.Info("cloud: device key changed", "action", string(a), "signer", signerKID, "kid", targetKID, "mode", targetMode)
	}
}

// AuditCertLine is the Verifier.AuditCert that writes a certified device to the log: the passkey's kid and the new device's kid (public hashes) and the mode, never a label or key bytes.
func AuditCertLine(lg *slog.Logger) func(passkeyKID, deviceKID, mode string) {
	return func(passkeyKID, deviceKID, mode string) {
		lg.Info("cloud: device certified by passkey", "passkey", passkeyKID, "kid", deviceKID, "mode", mode)
	}
}

// SetRefuseBefore sets (or, with the zero time, clears) RefuseBefore while no message is being handled.
func (v *Verifier) SetRefuseBefore(t time.Time) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.RefuseBefore = t
}
