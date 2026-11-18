package devicekey

import (
	"bytes"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Action is what a signed step-2 message asks for. Four, and only four.
type Action string

const (
	TrustPasskey  Action = "trust-passkey"
	ApproveDevice Action = "approve-device"
	RemoveDevice  Action = "remove-device"
	RaiseMode     Action = "raise-mode"
)

// MaxBody is the longest message, in bytes.
const MaxBody = 2048

// signLabel starts every signing input, so a signature made for another protocol or another purpose is never one of these.
const signLabel = "coral-hub/device-keys/2/"

// ErrBadForm is code bad_form: the body is not exactly the canonical form of a well-formed message of its action. It never carries the body.
var ErrBadForm = errors.New("bad_form")

var b64 = base64.RawURLEncoding.Strict()

// Message is one signed step-2 message, as parsed. The signer's mode is never in it: Coral reads that from its own device list.
type Message struct {
	Action    Action
	KID       string // the signer, 43 chars
	Computer  string // the fingerprint of this computer's X25519 public key, 43 chars
	Ts        int64  // unix seconds
	Nonce     string // 16 random bytes, 22 chars
	PasskeyPK string // trust-passkey
	Label     string // trust-passkey, approve-device
	TargetKID string // approve-device, remove-device, raise-mode
	TargetPK  string // approve-device
	Mode      string // approve-device, raise-mode: the TARGET mode
}

// keys gives each action's keys, in the one order of the canonical body: the four common ones, then the action's own.
func keys(a Action) []string {
	common := []string{"kid", "computer", "ts", "nonce"}
	switch a {
	case TrustPasskey:
		return append(common, "passkey_pk", "label")
	case ApproveDevice:
		return append(common, "target_kid", "target_pk", "label", "mode")
	case RemoveDevice:
		return append(common, "target_kid")
	case RaiseMode:
		return append(common, "target_kid", "mode")
	}
	return nil
}

func (m *Message) strField(k string) *string {
	switch k {
	case "kid":
		return &m.KID
	case "computer":
		return &m.Computer
	case "nonce":
		return &m.Nonce
	case "passkey_pk":
		return &m.PasskeyPK
	case "label":
		return &m.Label
	case "target_kid":
		return &m.TargetKID
	case "target_pk":
		return &m.TargetPK
	case "mode":
		return &m.Mode
	}
	return nil
}

// ComputerFingerprint is base64url (no padding) of the SHA-256 of the 32 raw bytes of the computer's X25519 public key: the `computer` of every body.
func ComputerFingerprint(pub []byte) string {
	s := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(s[:])
}

// fixedB64 checks a base64url, unpadded, canonical string of exactly n characters that decodes to want bytes.
func fixedB64(s string, n, want int) ([]byte, bool) {
	if len(s) != n {
		return nil, false
	}
	b, err := b64.DecodeString(s)
	return b, err == nil && len(b) == want
}

func pointOK(s string) ([]byte, bool) {
	b, ok := fixedB64(s, 87, 65)
	if !ok || b[0] != 0x04 {
		return nil, false
	}
	if _, err := ecdh.P256().NewPublicKey(b); err != nil { // on the curve; this also refuses the identity
		return nil, false
	}
	return b, true
}

func modeOK(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (m *Message) validate() error {
	ks := keys(m.Action)
	if ks == nil {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.KID, 43, 32); !ok {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.Computer, 43, 32); !ok {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.Nonce, 22, 16); !ok {
		return ErrBadForm
	}
	if m.Ts < 1 || m.Ts > 9_999_999_999_999_999 {
		return ErrBadForm
	}
	for _, k := range ks[4:] {
		v := *m.strField(k)
		switch k {
		case "passkey_pk":
			if _, ok := pointOK(v); !ok {
				return ErrBadForm
			}
		case "target_pk":
			pk, ok := pointOK(v)
			if !ok {
				return ErrBadForm
			}
			s := sha256.Sum256(pk)
			if m.TargetKID != base64.RawURLEncoding.EncodeToString(s[:]) { // the kid names the key it comes with
				return ErrBadForm
			}
		case "target_kid":
			if _, ok := fixedB64(v, 43, 32); !ok {
				return ErrBadForm
			}
		case "label":
			if !LabelOK(v) {
				return ErrBadForm
			}
		case "mode":
			if !modeOK(v) {
				return ErrBadForm
			}
		}
	}
	return nil
}

// jsonString writes a string as the body does: escaped only for the quote, the backslash and control characters (which no field can hold), and never a slash. Anything else, a non-ASCII rune too, is written as is.
func jsonString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte("0123456789abcdef"[r>>4])
			b.WriteByte("0123456789abcdef"[r&15])
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// Canonical validates the message and returns its one byte form: the keys in their fixed order, no spaces, strings as above, the integer plain decimal.
func (m Message) Canonical() ([]byte, error) {
	if err := m.validate(); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range keys(m.Action) {
		if i > 0 {
			b.WriteByte(',')
		}
		jsonString(&b, k)
		b.WriteByte(':')
		if k == "ts" {
			b.WriteString(strconv.FormatInt(m.Ts, 10))
		} else {
			jsonString(&b, *m.strField(k))
		}
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// SigningInput is what the device key signs: the fixed label, the action, one zero byte, then the canonical body. The action in it means a signature for one purpose is never another's.
func SigningInput(a Action, canonical []byte) []byte {
	out := make([]byte, 0, len(signLabel)+len(a)+1+len(canonical))
	out = append(out, signLabel...)
	out = append(out, a...)
	out = append(out, 0)
	return append(out, canonical...)
}

// Parse reads a body strictly: at most 2048 bytes, exactly the action's keys in order, string values for the strings and a plain integer for ts, every field well formed, and, last, the bytes equal to the canonical form
// rebuilt from what was read. Anything else is ErrBadForm and nothing is returned.
func Parse(a Action, raw []byte) (Message, error) {
	if len(raw) == 0 || len(raw) > MaxBody || !utf8.Valid(raw) || keys(a) == nil {
		return Message{}, ErrBadForm
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return Message{}, ErrBadForm
	}
	m := Message{Action: a}
	for _, want := range keys(a) {
		kt, err := dec.Token()
		if k, ok := kt.(string); err != nil || !ok || k != want { // out of order, missing, unknown or duplicate
			return Message{}, ErrBadForm
		}
		vt, err := dec.Token()
		if err != nil {
			return Message{}, ErrBadForm
		}
		if want == "ts" {
			n, ok := vt.(json.Number)
			if !ok || !plainInt(string(n)) {
				return Message{}, ErrBadForm
			}
			m.Ts, _ = strconv.ParseInt(string(n), 10, 64)
			continue
		}
		s, ok := vt.(string)
		if !ok {
			return Message{}, ErrBadForm
		}
		*m.strField(want) = s
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return Message{}, ErrBadForm
	}
	if _, err := dec.Token(); err != io.EOF { // nothing after the object
		return Message{}, ErrBadForm
	}
	canon, err := m.Canonical()
	if err != nil || !bytes.Equal(canon, raw) {
		return Message{}, ErrBadForm
	}
	return m, nil
}

// plainInt is a decimal integer with no sign, no leading zero, no point and no exponent, at most 16 digits.
func plainInt(s string) bool {
	if s == "" || len(s) > 16 || s[0] == '0' {
		return false
	}
	return strings.Trim(s, "0123456789") == ""
}
