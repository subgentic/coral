package devicekey_test

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

var b64 = base64.RawURLEncoding

// Fixed keys: P-256 points from fixed scalars, and a fixed X25519 computer key. The same bytes are in testdata/device-keys-vectors.json for the Hub and the browser module.
func p256pub(t *testing.T, seed byte) string {
	t.Helper()
	d := make([]byte, 32)
	for i := range d {
		d[i] = seed + byte(i)
	}
	d[0] &= 0x7f
	k, err := ecdh.P256().NewPrivateKey(d)
	require.NoError(t, err)
	return b64.EncodeToString(k.PublicKey().Bytes())
}

func kidOf(pk string) string {
	raw, _ := b64.DecodeString(pk)
	s := sha256.Sum256(raw)
	return b64.EncodeToString(s[:])
}

type fx struct{ signerPK, signerKID, targetPK, targetKID, passkeyPK, computer, nonce string }

func fixture(t *testing.T) fx {
	t.Helper()
	f := fx{signerPK: p256pub(t, 1), targetPK: p256pub(t, 50), passkeyPK: p256pub(t, 100)}
	f.signerKID, f.targetKID = kidOf(f.signerPK), kidOf(f.targetPK)
	x, err := ecdh.X25519().NewPrivateKey([]byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	f.computer = devicekey.ComputerFingerprint(x.PublicKey().Bytes())
	f.nonce = b64.EncodeToString([]byte("nonce-16-bytes!!"))
	return f
}

func (f fx) msg(a devicekey.Action) devicekey.Message {
	m := devicekey.Message{Action: a, KID: f.signerKID, Computer: f.computer, Ts: 1800000000, Nonce: f.nonce}
	switch a {
	case devicekey.TrustPasskey:
		m.PasskeyPK, m.Label = f.passkeyPK, "Work phone"
	case devicekey.ApproveDevice:
		m.TargetKID, m.TargetPK, m.Label, m.Mode = f.targetKID, f.targetPK, "My laptop", "interact"
	case devicekey.RemoveDevice:
		m.TargetKID = f.targetKID
	case devicekey.RaiseMode:
		m.TargetKID, m.Mode = f.targetKID, "interact"
	}
	return m
}

var actions = []devicekey.Action{devicekey.TrustPasskey, devicekey.ApproveDevice, devicekey.RemoveDevice, devicekey.RaiseMode}

// The canonical form, written out by hand for one action so the code is not its own oracle: keys in the fixed order, no spaces, strings as given, integers plain.
func TestCanonicalFormByHand(t *testing.T) {
	f := fixture(t)
	got, err := f.msg(devicekey.RaiseMode).Canonical()
	require.NoError(t, err)
	want := `{"kid":"` + f.signerKID + `","computer":"` + f.computer + `","ts":1800000000,"nonce":"` + f.nonce + `","target_kid":"` + f.targetKID + `","mode":"interact"}`
	assert.Equal(t, want, string(got))
	assert.Equal(t, 43, len(f.signerKID))
	assert.Equal(t, 43, len(f.computer))
	assert.Equal(t, 22, len(f.nonce))
}

func TestEveryActionRoundTripsAndSigningInputIsLabelActionNulBody(t *testing.T) {
	f := fixture(t)
	for _, a := range actions {
		m := f.msg(a)
		c, err := m.Canonical()
		require.NoError(t, err, a)
		back, err := devicekey.Parse(a, c)
		require.NoError(t, err, a)
		assert.Equal(t, m, back, a)
		assert.Equal(t, "coral-hub/device-keys/2/"+string(a)+"\x00"+string(c), string(devicekey.SigningInput(a, c)))
	}
}

func TestSigningInputsDifferByAction(t *testing.T) {
	f := fixture(t)
	c, _ := f.msg(devicekey.RemoveDevice).Canonical()
	assert.NotEqual(t, devicekey.SigningInput(devicekey.RemoveDevice, c), devicekey.SigningInput(devicekey.RaiseMode, c), "a signature for one purpose is not another's")
}

func TestLabelWithQuoteAndBackslashIsEscapedOnlyForThose(t *testing.T) {
	f := fixture(t)
	m := f.msg(devicekey.TrustPasskey)
	m.Label = `a"b\c/d`
	c, err := m.Canonical()
	require.NoError(t, err)
	assert.Contains(t, string(c), `"label":"a\"b\\c/d"`, `a slash is never escaped`)
	back, err := devicekey.Parse(devicekey.TrustPasskey, c)
	require.NoError(t, err)
	assert.Equal(t, m.Label, back.Label)
}

// bad_form: every one of these is refused, and none may come back as a message.
func TestParseRefusesEveryNonCanonicalOrMalformedBody(t *testing.T) {
	f := fixture(t)
	good, _ := f.msg(devicekey.RaiseMode).Canonical()
	g := string(good)
	sub := func(old, new string) string { return strings.Replace(g, old, new, 1) }
	pre := `{"kid":"` + f.signerKID + `","computer":"` + f.computer + `","ts":1800000000,"nonce":"` + f.nonce + `",`
	cases := map[string]string{
		"spaces after colon":        sub(`"ts":1800000000`, `"ts": 1800000000`),
		"newline":                   g + "\n",
		"trailing data":             g + "{}",
		"leading space":             " " + g,
		"keys out of order":         `{"computer":"` + f.computer + `","kid":"` + f.signerKID + `","ts":1800000000,"nonce":"` + f.nonce + `","target_kid":"` + f.targetKID + `","mode":"interact"}`,
		"unknown key":               sub(`"mode":"interact"}`, `"mode":"interact","extra":"x"}`),
		"missing key":               pre + `"target_kid":"` + f.targetKID + `"}`,
		"duplicate key":             sub(`"mode":"interact"`, `"mode":"interact","mode":"interact"`),
		"ts leading zero":           sub(`1800000000`, `01800000000`),
		"ts plus sign":              sub(`1800000000`, `+1800000000`),
		"ts float":                  sub(`1800000000`, `1800000000.0`),
		"ts exponent":               sub(`1800000000`, `18e8`),
		"ts string":                 sub(`"ts":1800000000`, `"ts":"1800000000"`),
		"ts negative":               sub(`1800000000`, `-1`),
		"ts zero":                   sub(`1800000000`, `0`),
		"ts too long":               sub(`1800000000`, `18000000000000000000`),
		"escaped letter":            sub(`"mode":"interact"`, `"mode":"writ\u0065"`),
		"escaped slash":             sub(`"mode":"interact"`, `"mode":"wr\/ite"`),
		"kid short":                 sub(f.signerKID, f.signerKID[:42]),
		"kid padded":                sub(f.signerKID, f.signerKID[:42]+"="),
		"kid not base64url":         sub(f.signerKID, f.signerKID[:42]+"+"),
		"computer long":             sub(f.computer, f.computer+"A"),
		"nonce 15 bytes":            sub(f.nonce, b64.EncodeToString([]byte("fifteen-bytes!!"))),
		"nonce non-canonical bits":  sub(f.nonce, f.nonce[:21]+"B"),
		"mode empty":                sub(`"mode":"interact"`, `"mode":""`),
		"mode with a space":         sub(`"mode":"interact"`, `"mode":"wr ite"`),
		"mode uppercase":            sub(`"mode":"interact"`, `"mode":"Write"`),
		"mode 33 chars":             sub(`"mode":"interact"`, `"mode":"`+strings.Repeat("a", 33)+`"`),
		"value is null":             sub(`"mode":"interact"`, `"mode":null`),
		"value is a number":         sub(`"mode":"interact"`, `"mode":5`),
		"array body":                `[` + g + `]`,
		"not json":                  `kid`,
		"empty":                     ``,
		"over 2048 bytes":           pre + `"target_kid":"` + f.targetKID + `","mode":"` + strings.Repeat("a", 2100) + `"}`,
		"invalid utf-8 in a string": sub(`"mode":"interact"`, "\"mode\":\"wr\xffte\""),
	}
	for name, body := range cases {
		_, err := devicekey.Parse(devicekey.RaiseMode, []byte(body))
		assert.ErrorIs(t, err, devicekey.ErrBadForm, name)
	}
}

func TestParseRefusesBadKeysAndLabelsPerAction(t *testing.T) {
	f := fixture(t)
	a := f.msg(devicekey.ApproveDevice)
	mut := func(fn func(*devicekey.Message)) error {
		m := a
		fn(&m)
		c, err := m.Canonical()
		if err != nil {
			return err
		}
		_, err = devicekey.Parse(devicekey.ApproveDevice, c)
		return err
	}
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.TargetPK = b64.EncodeToString(append([]byte{0x04}, make([]byte, 64)...)) }), devicekey.ErrBadForm, "a point not on the curve")
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.TargetPK = p256pub(t, 7)[:86] }), devicekey.ErrBadForm, "86 characters")
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.TargetKID = f.signerKID }), devicekey.ErrBadForm, "target_kid must be the hash of target_pk")
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.Label = "a\tb" }), devicekey.ErrBadForm, "label with a control character")
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.Label = " lead" }), devicekey.ErrBadForm, "label not in cleaned form")
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.Label = "" }), devicekey.ErrBadForm)
	assert.ErrorIs(t, mut(func(m *devicekey.Message) { m.Ts = 0 }), devicekey.ErrBadForm)
	assert.NoError(t, mut(func(m *devicekey.Message) {}))
	// a body of one action is not another's: remove-device's keys are not raise-mode's
	rm, _ := f.msg(devicekey.RemoveDevice).Canonical()
	_, err := devicekey.Parse(devicekey.RaiseMode, rm)
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
	_, err = devicekey.Parse(devicekey.Action("delete-everything"), rm)
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "an action outside the four")
}

func TestPasskeyPKMustBeOnTheCurve(t *testing.T) {
	f := fixture(t)
	m := f.msg(devicekey.TrustPasskey)
	m.PasskeyPK = b64.EncodeToString(append([]byte{0x04}, make([]byte, 64)...))
	c, err := m.Canonical()
	if err == nil {
		_, err = devicekey.Parse(devicekey.TrustPasskey, c)
	}
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
}

func TestComputerFingerprintIsBase64urlSHA256OfThe32Bytes(t *testing.T) {
	pub := []byte("0123456789abcdef0123456789abcdef")
	s := sha256.Sum256(pub)
	assert.Equal(t, b64.EncodeToString(s[:]), devicekey.ComputerFingerprint(pub))
}

// The vectors file is what the Hub's and the browser's tests read: the same bytes. UPDATE regenerates it; a normal run checks it.
type vector struct {
	Name            string `json:"name"`
	Action          string `json:"action"`
	Body            string `json:"body"`
	SigningInputHex string `json:"signing_input_hex,omitempty"`
	Refused         bool   `json:"refused,omitempty"`
}

func TestVectorsFile(t *testing.T) {
	f := fixture(t)
	var want []vector
	for _, a := range actions {
		c, err := f.msg(a).Canonical()
		require.NoError(t, err)
		want = append(want, vector{Name: string(a), Action: string(a), Body: string(c), SigningInputHex: hex.EncodeToString(devicekey.SigningInput(a, c))})
	}
	good, _ := f.msg(devicekey.RaiseMode).Canonical()
	for _, r := range []struct{ n, body string }{
		{"refused: spaces", strings.Replace(string(good), `"ts":`, `"ts": `, 1)},
		{"refused: keys out of order", `{"computer":"` + f.computer + `","kid":"` + f.signerKID + `","ts":1800000000,"nonce":"` + f.nonce + `","target_kid":"` + f.targetKID + `","mode":"interact"}`},
		{"refused: ts leading zero", strings.Replace(string(good), `1800000000`, `01800000000`, 1)},
		{"refused: escaped slash", strings.Replace(string(good), `"interact"`, `"wr\/ite"`, 1)},
	} {
		want = append(want, vector{Name: r.n, Action: "raise-mode", Body: r.body, Refused: true})
	}
	doc := struct {
		Note    string            `json:"note"`
		Keys    map[string]string `json:"keys"`
		Vectors []vector          `json:"vectors"`
	}{
		Note:    "Device keys step 2 (coral-hub wire format draft 7, section 10). Signing input = \"coral-hub/device-keys/2/\" + action + 0x00 + body. Keys: P-256 points from fixed scalars (byte i = seed+i, first byte & 0x7f), computer = base64url SHA-256 of the 32 X25519 public bytes of the private key \"0123456789abcdef0123456789abcdef\".",
		Keys:    map[string]string{"signer_pk": f.signerPK, "signer_kid": f.signerKID, "target_pk": f.targetPK, "target_kid": f.targetKID, "passkey_pk": f.passkeyPK, "computer": f.computer, "nonce": f.nonce},
		Vectors: want,
	}
	out, err := json.MarshalIndent(doc, "", " ")
	require.NoError(t, err)
	const path = "testdata/device-keys-vectors.json"
	if os.Getenv("DEVICEKEY_VECTORS_UPDATE") == "1" {
		require.NoError(t, os.WriteFile(path, append(out, '\n'), 0o644))
	}
	have, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, string(out)+"\n", string(have), "regenerate with DEVICEKEY_VECTORS_UPDATE=1 only when the format is meant to change")
	// every refused vector is refused, every other one parses
	for _, v := range want {
		_, err := devicekey.Parse(devicekey.Action(v.Action), []byte(v.Body))
		if v.Refused {
			assert.ErrorIs(t, err, devicekey.ErrBadForm, v.Name)
		} else {
			assert.NoError(t, err, v.Name)
		}
	}
}

// QA Engineer 4 (slice 3, INFO): the ts cap. Sixteen digits is the most; 9_999_999_999_999_999 parses and the verifier refuses it as outside the window, a seventeenth digit is a bad form.
func TestTsCapIsSixteenDigits(t *testing.T) {
	f := fixture(t)
	good, _ := f.msg(devicekey.RaiseMode).Canonical()
	sub := func(ts string) []byte { return []byte(strings.Replace(string(good), `1800000000`, ts, 1)) }
	m, err := devicekey.Parse(devicekey.RaiseMode, sub("9999999999999999"))
	require.NoError(t, err)
	assert.EqualValues(t, int64(9999999999999999), m.Ts)
	_, err = devicekey.Parse(devicekey.RaiseMode, sub("10000000000000000"))
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
}

func TestVerifierRefusesTheLargestTsAsOutsideTheWindow(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	m := r.raise(r.signer, target.kid, "interact")
	m.Ts = 9999999999999999
	r.refused(devicekey.ErrTsWindow, m, r.signer, t0)
}
