package cloud

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// The device key (coral-hub device keys, step 1, #16726; the Hub's Security ruling, their #218034). The owner puts this computer's device PUBLIC key in a file; Coral reads it once, removes the file, and sends the key
// in the bootstrap redeem body as device_pk. Only the public key ever goes in a hand-off file or any request: Coral's own private key and signing are step 2. The key is P-256 and nothing else; any other
// algorithm needs a new field and the Hub's Security's read.

// deviceKeyLen is the raw uncompressed P-256 point: 0x04, X, Y.
const deviceKeyLen = 65

// ErrBadDeviceKey is why a device key file or value was refused. It never carries the content.
var ErrBadDeviceKey = errors.New("the device key is not one P-256 public key (65 bytes, uncompressed, base64url without padding, on one line)")

// ParseDeviceKey checks a device public key as the file holds it (one line) or the redeem body carries it: base64url without padding of the raw 65-byte uncompressed P-256 point, a point on the curve. It returns
// the canonical device_pk. The encoding lives here, in one place.
func ParseDeviceKey(raw []byte) (string, error) {
	s := strings.TrimSpace(string(raw))
	if len(s) != base64.RawURLEncoding.EncodedLen(deviceKeyLen) {
		return "", ErrBadDeviceKey
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != deviceKeyLen || b[0] != 0x04 {
		return "", ErrBadDeviceKey
	}
	if _, err := ecdh.P256().NewPublicKey(b); err != nil { // a point on the curve, not just 65 bytes
		return "", ErrBadDeviceKey
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// DeviceKeyID is the kid of a device key: base64url (no padding) of the SHA-256 of the raw public key. Step 1 does not use it; it is the name the Hub and step 2 give the key.
func DeviceKeyID(pk string) string {
	b, err := base64.RawURLEncoding.DecodeString(pk)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
