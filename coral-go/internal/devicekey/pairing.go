package devicekey

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"strings"

	"golang.org/x/crypto/hkdf"
	"io"
)

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
