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
	"time"

	"golang.org/x/crypto/hkdf"

	"github.com/subgentic/coral/internal/store"
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
	added, err := st.AddDeviceKey(ctx, store.DeviceKey{KID: a.KID, PK: pk, Label: label, Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice}, now)
	if err != nil {
		return "", mapStoreErr(err)
	}
	if !added {
		if _, err := st.PromoteDeviceOrigin(ctx, a.KID, now); err != nil {
			return "", err
		}
	}
	return a.KID, nil
}
