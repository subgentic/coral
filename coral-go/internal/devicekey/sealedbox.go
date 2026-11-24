package devicekey

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"

	"golang.org/x/crypto/hkdf"
)

// The sealed box (#20966, design #20901 v8, coral-hub's MUST). A relayed kind that must hand back a secret (a new request key, an Allow code) never returns it in the clear: the browser makes a one-time X25519 key pair and
// puts the public half in the signed query (box_pk), so the signature covers it and a Hub cannot swap it; this computer seals the value to that key and returns only the box. A Hub relaying the answer holds ciphertext.
//
// The box is the JSON {"v":1,"epk","nonce","ct"}, each of the last three base64url without padding: epk the computer's one-time X25519 public key, nonce the 12-byte AES-GCM nonce, ct the sealed bytes. The key is
// HKDF-SHA256(ECDH(epk, box_pk), salt = epk || box_pk, info = "coral/link-box/1"), 32 bytes, AES-256-GCM, and the additional data is "coral/link-box/1" 0x00 purpose 0x00 request nonce 0x00 object, so a box opens only for
// the kind it was made for, the relayed request (its signed nonce) and the object (the link request's id, or the key's id) it names. The browser throws its private key away once it has opened the box.

const boxInfo = "coral/link-box/1"

// ErrBoxKey is returned when the browser's public key is missing or is not a usable X25519 key: nothing is sealed, so nothing is returned.
var ErrBoxKey = errors.New("box_key")

// BoxKeyOK reports whether pk is a well-formed one-time public key: 43 base64url characters naming 32 bytes (the form the signed query carries).
func BoxKeyOK(pk string) bool {
	_, ok := fixedB64(pk, 43, 32)
	return ok
}

// SealBox seals plaintext to the browser's one-time key pk for one purpose (the kind), one relayed request (its signed nonce) and one object. It never returns the plaintext, and a key that is not a good one seals nothing.
func SealBox(pk, purpose, nonce, object string, plaintext []byte) ([]byte, error) {
	raw, ok := fixedB64(pk, 43, 32)
	if !ok {
		return nil, ErrBoxKey
	}
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return nil, ErrBoxKey
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(pub) // refuses a low-order point (an all-zero result)
	if err != nil {
		return nil, ErrBoxKey
	}
	epk := eph.PublicKey().Bytes()
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, shared, append(append([]byte{}, epk...), raw...), []byte(boxInfo)), key); err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	n := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, n); err != nil {
		return nil, err
	}
	ct := gcm.Seal(nil, n, plaintext, []byte(boxInfo+"\x00"+purpose+"\x00"+nonce+"\x00"+object))
	return json.Marshal(map[string]any{"v": 1, "epk": b64.EncodeToString(epk), "nonce": b64.EncodeToString(n), "ct": b64.EncodeToString(ct)})
}

// BoxQuery is the one query of a signed allow-link or make-link-key request, and the browser's key in it: exactly box_pk= and 43 base64url characters, nothing else. ok is false for any other query, a repeated key,
// or none.
func BoxQuery(target string) (pk string, ok bool) {
	i := indexByte(target, '?')
	if i < 0 {
		return "", false
	}
	q := target[i+1:]
	const p = "box_pk="
	if len(q) != len(p)+43 || q[:len(p)] != p || !BoxKeyOK(q[len(p):]) {
		return "", false
	}
	return q[len(p):], true
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
