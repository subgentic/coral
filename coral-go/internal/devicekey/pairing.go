package devicekey

import (
	"context"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/hkdf"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Pairing refusals. They are what Coral tells the person; none carries a key, a MAC or the secret.
var (
	ErrPairingNoKey    = errors.New("pairing_no_key")    // the Hub's answer has no pk
	ErrPairingNoSecret = errors.New("pairing_no_secret") // Coral holds no secret for this code (a restart, or the link had none)
	ErrPairingMAC      = errors.New("pairing_mac")       // the key or the proof is not the browser's
)

// PairingAnswer is the pairing object in the Hub's poll answer: v, kid, mac and the echoed user_code (a diagnostic only) as the Hub holds them, and the browser's public key.
type PairingAnswer struct {
	V        int
	KID, MAC string
	UserCode string
	PK       string
}

// String prints the kid only: the mac and the key never reach a log or a failing test's output through a stray %v.
func (a PairingAnswer) String() string { return "pairing{kid:" + a.KID + "}" }

// GoString is the same, for %#v.
func (a PairingAnswer) GoString() string { return a.String() }

// NewPairingSecret is 16 random bytes, base64url, 22 characters: what the `#p=` link carries and the Hub never sees.
func NewPairingSecret() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return b64.EncodeToString(b)
}

// ParsePairingSecret returns the 16 bytes of a well-formed secret.
func ParsePairingSecret(s string) ([]byte, bool) { return fixedB64(s, 22, 16) }

// CheckPairing decides whether the browser's key may be added. Coral uses its OWN user_code and the label the Hub holds, never the answer's echo. The order: the secret is held, pk is there, v is 1, pk is a point, kid is the hash of pk, then the MAC compare in constant time. A refusal returns no key and writes nothing; the caller stores nothing before it passes.
func CheckPairing(secret []byte, userCode, label string, a PairingAnswer) ([]byte, error) {
	if len(secret) != 16 {
		return nil, ErrPairingNoSecret
	}
	if a.PK == "" {
		return nil, ErrPairingNoKey
	}
	pk, ok := fixedB64(a.PK, 87, 65)
	if !ok || a.V != 1 {
		return nil, ErrPairingMAC
	}
	if _, err := ecdh.P256().NewPublicKey(pk); err != nil {
		return nil, ErrPairingMAC
	}
	sum := sha256.Sum256(pk)
	if b64.EncodeToString(sum[:]) != a.KID {
		return nil, ErrPairingMAC
	}
	mac, ok := fixedB64(a.MAC, 43, 32)
	if !ok || !hmac.Equal(PairMAC(secret, userCode, label, pk), mac) {
		return nil, ErrPairingMAC
	}
	return pk, nil
}

const (
	pairMACInfo  = "coral-hub/device-keys/1/pair-mac"
	replyMACInfo = "coral-hub/device-keys/1/reply-mac"
)

func macKey(secret []byte, info string) []byte {
	k := make([]byte, sha256.Size)
	_, _ = io.ReadFull(hkdf.New(sha256.New, secret, nil, []byte(info)), k)
	return k
}

// PairMAC is the request-direction MAC the browser puts on its pairing request: HMAC-SHA256(HKDF(secret, empty salt, pair-mac), "v1" 0x00 user_code 0x00 label 0x00 pk_raw) (wire format section 9).
func PairMAC(secret []byte, userCode, label string, pkRaw []byte) []byte {
	h := hmac.New(sha256.New, macKey(secret, pairMACInfo))
	h.Write([]byte("v1\x00" + userCode + "\x00" + label + "\x00"))
	h.Write(pkRaw)
	return h.Sum(nil)
}

// ReplyMAC is the answer-direction MAC Coral sends with its X25519 public key: HMAC-SHA256(HKDF(secret, empty salt, reply-mac), "v1" 0x00 user_code 0x00 pk_raw 0x00 computer_pub). The different info label means a reply cannot be turned into a request.
func ReplyMAC(secret []byte, userCode string, pkRaw, computerPub []byte) []byte {
	h := hmac.New(sha256.New, macKey(secret, replyMACInfo))
	h.Write([]byte("v1\x00" + userCode + "\x00"))
	h.Write(pkRaw)
	h.Write([]byte{0})
	h.Write(computerPub)
	return h.Sum(nil)
}

// VerifyReplyMAC compares in constant time.
func VerifyReplyMAC(secret []byte, userCode string, pkRaw, computerPub, mac []byte) bool {
	return hmac.Equal(ReplyMAC(secret, userCode, pkRaw, computerPub), mac)
}

// DisplayFingerprint is what the browser shows for a computer key: the first 16 base32 characters (RFC 4648, no padding) of SHA-256(computer_pub), in groups of four.
func DisplayFingerprint(computerPub []byte) string {
	s := sha256.Sum256(computerPub)
	e := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(s[:])[:16]
	return strings.Join([]string{e[0:4], e[4:8], e[8:12], e[12:16]}, "-")
}

// PairingStore is the part of the store the pairing path writes.
type PairingStore interface {
	AddDeviceKey(ctx context.Context, k store.DeviceKey, now time.Time) (bool, error)
	PromoteDeviceOrigin(ctx context.Context, kid string, now time.Time) (bool, error)
	ActiveDeviceKey(ctx context.Context, kid string, now time.Time) (store.DeviceKey, error)
	SetDeviceMode(ctx context.Context, kid, mode, by string, now time.Time) error
}

// CompletePairing checks the Hub's pairing answer and, only when it passes, adds the browser's key as a `pairing` device at mode (the web setting). A key already listed as bootstrap or noproof is promoted to pairing, the one upward step; its mode is not touched. It is the only caller of the promotion.
func CompletePairing(ctx context.Context, st PairingStore, secret []byte, userCode, label string, a PairingAnswer, mode string, now time.Time) (string, error) {
	if !LabelOK(label) {
		return "", ErrPairingMAC
	}
	pk, err := CheckPairing(secret, userCode, label, a)
	if err != nil {
		return "", err
	}
	added, err := st.AddDeviceKey(ctx, store.DeviceKey{KID: a.KID, PK: pk, Label: label, Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, now)
	if err != nil {
		return "", mapStoreErr(err)
	}
	if !added {
		if _, err := st.PromoteDeviceOrigin(ctx, a.KID, now); err != nil {
			return "", err
		}
		if _, err := cappedMode(ctx, st, a.KID, mode, now); err != nil {
			return "", err
		}
	}
	return a.KID, nil
}

// AddPairedKey lists an already-verified browser key as a `pairing` device at mode, after the person at the computer said Allow (#21880): the pairing proof was checked by SecretHold.Check and the Allow is the local Operator's. A key already listed as bootstrap or noproof is promoted to pairing with its mode untouched. With CompletePairing, the only callers of the promotion.
func AddPairedKey(ctx context.Context, st PairingStore, kid string, pk []byte, label, mode string, now time.Time) error {
	added, err := st.AddDeviceKey(ctx, store.DeviceKey{KID: kid, PK: pk, Label: label, Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, now)
	if err != nil {
		return mapStoreErr(err)
	}
	final := mode
	if !added {
		if _, err := st.PromoteDeviceOrigin(ctx, kid, now); err != nil {
			return err
		}
		if final, err = cappedMode(ctx, st, kid, mode, now); err != nil {
			return err
		}
	}
	// The mark the Needs you notice reads: the person at this computer allowed this key at this mode (and it stamps the time of the change).
	if err := st.SetDeviceMode(ctx, kid, final, store.PairBrowserBy, now); err != nil {
		return mapStoreErr(err)
	}
	return nil
}

// cappedMode is the mode a just-promoted key ends with: a promoted key becomes trusted (#21883), so it keeps no mode above the one the person chose. Capped, never raised: a key below the chosen mode stays where it is. When the stored mode is above, it is set down here (by this computer).
func cappedMode(ctx context.Context, st PairingStore, kid, chosen string, now time.Time) (string, error) {
	k, err := st.ActiveDeviceKey(ctx, kid, now)
	if err != nil {
		return "", mapStoreErr(err)
	}
	have, ok := tunnel.ParseMode(k.Mode)
	want, wok := tunnel.ParseMode(chosen)
	if ok && wok && have <= want {
		return k.Mode, nil
	}
	if err := st.SetDeviceMode(ctx, kid, chosen, "", now); err != nil {
		return "", mapStoreErr(err)
	}
	return chosen, nil
}

const secretLife = 10 * time.Minute

// SecretHold keeps one pairing secret in memory: single use, dead after ten minutes, at the first success or at the third failed check. A failed pk check counts like a failed MAC; an answer with no pk does not. The bytes are zeroed when it dies.
type SecretHold struct {
	mu      sync.Mutex
	secret  []byte
	expires time.Time
	fails   int
}

// NewSecretHold holds secret (16 bytes; anything else is a hold that is already dead) from now.
func NewSecretHold(secret []byte, now time.Time) *SecretHold {
	h := &SecretHold{expires: now.Add(secretLife)}
	if len(secret) == 16 {
		h.secret = append([]byte(nil), secret...)
	}
	return h
}

func (h *SecretHold) die() {
	for i := range h.secret {
		h.secret[i] = 0
	}
	h.secret = nil
}

// Alive reports whether the secret can still be used at now.
func (h *SecretHold) Alive(now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.aliveLocked(now)
}

func (h *SecretHold) aliveLocked(now time.Time) bool {
	if h.secret != nil && now.After(h.expires) {
		h.die()
	}
	return h.secret != nil
}

// Wipe ends the hold at once (the enrollment was cancelled or finished).
func (h *SecretHold) Wipe() {
	h.mu.Lock()
	h.die()
	h.mu.Unlock()
}

// Complete is CompletePairing with this hold's secret and its life rules. On success it also returns Coral's reply MAC for computerPub (the 32 raw bytes of the computer key), made before the secret is zeroed.
func (h *SecretHold) Complete(ctx context.Context, st PairingStore, userCode, label string, a PairingAnswer, mode string, computerPub []byte, now time.Time) (kid string, replyMAC []byte, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.aliveLocked(now) {
		return "", nil, ErrPairingNoSecret
	}
	kid, err = CompletePairing(ctx, st, h.secret, userCode, label, a, mode, now)
	switch {
	case err == nil:
		pk, _ := b64.DecodeString(a.PK)
		replyMAC = ReplyMAC(h.secret, userCode, pk, computerPub)
		h.die()
	case errors.Is(err, ErrPairingMAC):
		if h.fails++; h.fails >= 3 {
			h.die()
		}
	}
	return kid, replyMAC, err
}

// KIDOf is a device key's id: the base64url SHA-256 of its 65 raw bytes.
func KIDOf(pk []byte) string {
	s := sha256.Sum256(pk)
	return b64.EncodeToString(s[:])
}
