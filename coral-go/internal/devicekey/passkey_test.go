package devicekey_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// The passkey certificate (#19669 slice 6, plan item 12): a WebAuthn assertion verified from the stored passkey public key alone, over challenge = SHA-256(label 0x00 device_pk 0x00 ts). It adds a device at view.

const hubOrigin = "https://app.coralhub.dev"

type pkRig struct {
	*rig
	passkey signer
}

func newPkRig(t *testing.T) *pkRig {
	t.Helper()
	r := newRig(t)
	r.v.HubOrigin = hubOrigin
	p := newSigner(t)
	r.add(p, "view", store.DeviceOriginPairing, store.DeviceKindPasskey)
	return &pkRig{rig: r, passkey: p}
}

type assertion struct {
	rpID, typ, origin string
	flags             byte
	challenge         []byte
	signWith          *ecdsa.PrivateKey
	extraClient       map[string]any // more clientDataJSON keys
	rawClient         string         // clientDataJSON as given, when set
	dupType           bool           // the valid clientDataJSON with its type key repeated
	adExtra           []byte         // bytes after the 37
	computer          string         // the fingerprint the challenge was made for
}

// cert builds a certificate for a new device, signed as a browser's passkey would, with the knobs a test turns.
func (r *pkRig) cert(dev signer, a *assertion) devicekey.Certificate {
	r.t.Helper()
	devRaw, _ := b64.DecodeString(dev.pk)
	c := devicekey.Certificate{Label: "New phone", DevicePK: dev.pk, Ts: t0.Unix()}
	if a == nil {
		a = &assertion{}
	}
	if a.rpID == "" {
		a.rpID = "app.coralhub.dev"
	}
	if a.typ == "" {
		a.typ = "webauthn.get"
	}
	if a.origin == "" {
		a.origin = hubOrigin
	}
	if a.flags == 0 {
		a.flags = 0x05 // user present and user verified
	}
	if a.computer == "" {
		a.computer = r.computer
	}
	if a.challenge == nil {
		a.challenge = devicekey.Challenge(a.computer, c.Label, devRaw, c.Ts)
	}
	if a.signWith == nil {
		a.signWith = r.passkey.priv
	}
	rp := sha256.Sum256([]byte(a.rpID))
	ad := append(append(rp[:], a.flags, 0, 0, 0, 1), a.adExtra...)
	km := map[string]any{"type": a.typ, "challenge": b64.EncodeToString(a.challenge), "origin": a.origin}
	for k, v := range a.extraClient {
		km[k] = v
	}
	cd, err := json.Marshal(km)
	require.NoError(r.t, err)
	if a.dupType {
		cd = append([]byte(`{"type":"webauthn.get",`), cd[1:]...) // everything else valid: only the repeated key is wrong
	}
	if a.rawClient != "" {
		cd = []byte(a.rawClient)
	}
	cdh := sha256.Sum256(cd)
	h := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	rr, ss, err := ecdsa.Sign(rand.Reader, a.signWith, h[:])
	require.NoError(r.t, err)
	der, err := asn1.Marshal(struct{ R, S *big.Int }{rr, ss})
	require.NoError(r.t, err)
	c.AuthenticatorData, c.ClientDataJSON, c.Signature = b64.EncodeToString(ad), b64.EncodeToString(cd), b64.EncodeToString(der)
	return c
}

func (r *pkRig) handle(c devicekey.Certificate, now time.Time) error {
	_, err := r.v.HandleCertificate(context.Background(), c, now)
	return err
}

func (r *pkRig) refused(want error, c devicekey.Certificate, dev signer, now time.Time) {
	r.t.Helper()
	assert.ErrorIs(r.t, r.handle(c, now), want)
	_, ok := r.listed(dev.kid)
	assert.False(r.t, ok, "a refused certificate adds nothing")
}

func TestAPasskeyCertificateAddsAPairedDeviceAtView(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	require.NoError(t, r.handle(r.cert(dev, nil), t0))
	k, ok := r.listed(dev.kid)
	require.True(t, ok)
	assert.Equal(t, "view", k.Mode)
	assert.Equal(t, store.DeviceKindDevice, k.Kind)
	assert.Equal(t, store.DeviceOriginPairing, k.Origin)
	assert.Equal(t, "New phone", k.Label)
	p, _ := r.listed(r.passkey.kid)
	assert.Equal(t, t0.Unix(), p.LastUsedAt, "an accepted certificate touches the passkey")
}

func TestACertificateWithoutAHubOriginConfiguredIsRefused(t *testing.T) {
	r := newPkRig(t)
	r.v.HubOrigin = ""
	dev := newSigner(t)
	r.refused(devicekey.ErrBadSignature, r.cert(dev, nil), dev, t0)
}

func TestACertificateNamesNoPasskeyAndAnyOfTheActiveOnesMaySign(t *testing.T) {
	r := newPkRig(t)
	for i := 0; i < 3; i++ {
		r.add(newSigner(t), "view", store.DeviceOriginPairing, store.DeviceKindPasskey)
	}
	dev := newSigner(t)
	require.NoError(t, r.handle(r.cert(dev, nil), t0), "the rig's passkey is not the first listed")
}

func TestACertificateFromNoActivePasskeyIsOneBadSignature(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	// signed by a device-kind key: that row is no passkey
	r.refused(devicekey.ErrBadSignature, r.cert(dev, &assertion{signWith: r.signer.priv}), dev, t0)
	// a removed passkey
	require.NoError(t, r.ss.RemoveDeviceKey(context.Background(), r.passkey.kid, store.DeviceRemoved, t0))
	r.refused(devicekey.ErrBadSignature, r.cert(dev, nil), dev, t0)
}

func TestACertificateIsRefusedForEachWrongAssertionField(t *testing.T) {
	r := newPkRig(t)
	for name, a := range map[string]*assertion{
		"type":           {typ: "webauthn.create"},
		"origin":         {origin: "https://evil.example"},
		"origin path":    {origin: hubOrigin + "/x"},
		"rp id":          {rpID: "evil.example"},
		"no presence":    {flags: 0x04},
		"no user ver.":   {flags: 0x01},
		"challenge":      {challenge: make([]byte, 32)},
		"other computer": {computer: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		"cross origin":   {extraClient: map[string]any{"crossOrigin": true}},
		"top origin":     {extraClient: map[string]any{"topOrigin": hubOrigin}},
		"attested data":  {flags: 0x45, adExtra: []byte{1}},
		"38 bytes":       {adExtra: []byte{0}},
		"dup type key":   {dupType: true},
		"dup key raw":    {rawClient: `{"type":"webauthn.get","type":"webauthn.get","origin":"` + hubOrigin + `","challenge":"x"}`},
		"trailing":       {rawClient: `{"type":"webauthn.get"} {}`},
	} {
		dev := newSigner(t)
		c := r.cert(dev, a)
		assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadSignature, name)
		_, ok := r.listed(dev.kid)
		assert.False(t, ok, name)
	}
}

func TestACertificateChallengeBindsLabelDeviceKeyAndTime(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil)
	c.Label = "Other name" // the label changed after the passkey signed
	r.refused(devicekey.ErrBadSignature, c, dev, t0)
	other := newSigner(t)
	c = r.cert(dev, nil)
	c.DevicePK = other.pk // a different device key under the same signature
	r.refused(devicekey.ErrBadSignature, c, other, t0)
	c = r.cert(dev, nil)
	c.Ts++
	r.refused(devicekey.ErrBadSignature, c, dev, t0)
}

func TestACertificateSignedByAnotherKeyIsRefused(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	r.refused(devicekey.ErrBadSignature, r.cert(dev, &assertion{signWith: newSigner(t).priv}), dev, t0)
}

func TestACertificateSignatureMustBeDERES256(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil)
	c.Signature = b64.EncodeToString(make([]byte, 64)) // a P1363 form is not what a browser gives
	r.refused(devicekey.ErrBadSignature, c, dev, t0)
}

func TestACertificateTsWindowIsFiveMinutesEitherWay(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil) // ts = t0
	r.refused(devicekey.ErrTsWindow, c, dev, t0.Add(5*time.Minute+time.Second))
	r.refused(devicekey.ErrTsWindow, c, dev, t0.Add(-5*time.Minute-time.Second))
	require.NoError(t, r.handle(c, t0.Add(5*time.Minute)))
}

func TestACertificateCannotBeReplayed(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil)
	require.NoError(t, r.handle(c, t0))
	require.NoError(t, r.ss.RemoveDeviceKey(context.Background(), dev.kid, store.DeviceRemoved, t0.Add(time.Minute)))
	assert.ErrorIs(t, r.handle(c, t0.Add(2*time.Minute)), devicekey.ErrNonceRepeat, "a removed device is not re-added by the same certificate")
}

func TestACertificateForAnActiveOrRemovedDeviceKeyIsRefused(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	r.add(dev, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	c := r.cert(dev, nil)
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadForm)
	require.NoError(t, r.ss.RemoveDeviceKey(context.Background(), dev.kid, store.DeviceRemoved, t0))
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrSignerRemoved, "a key on the removed list is not added again")
}

func TestACertificateIsRefusedBadFormForABadDeviceKeyOrLabel(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil)
	c.DevicePK = "AAAA"
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadForm)
	c = r.cert(dev, nil)
	c.Label = " padded "
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadForm)
	assert.ErrorIs(t, r.handle(r.cert(dev, &assertion{extraClient: map[string]any{"pad": string(make([]byte, 1100))}}), t0), devicekey.ErrBadForm, "clientDataJSON over 1 KB")
	c = r.cert(dev, nil)
	c.Signature = b64.EncodeToString(make([]byte, 73))
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadForm, "a signature over 72 bytes")
	c = r.cert(dev, nil)
	c.AuthenticatorData = "!"
	assert.ErrorIs(t, r.handle(c, t0), devicekey.ErrBadForm)
}

func TestACertificateIsRefusedWhileAClearIsPendingAndBeforeStartAndOnAClockBack(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	r.v.Refuse = func() bool { return true }
	r.refused(devicekey.ErrListUnavailable, r.cert(dev, nil), dev, t0)
	r.v.Refuse = nil
	r.v.RefuseBefore = t0.Add(time.Hour)
	r.refused(devicekey.ErrBeforeStart, r.cert(dev, nil), dev, t0)
}

func TestACertificateRespectsTheKeyLimits(t *testing.T) {
	r := newPkRig(t)
	for i := 0; i < 9; i++ { // the rig has the launch signer and the passkey: 10 active in all
		r.add(newSigner(t), "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	}
	dev := newSigner(t)
	r.refused(devicekey.ErrKeyLimit, r.cert(dev, nil), dev, t0)
}

func TestChallengeIsTheHashOfThePrefixComputerLabelKeyAndBigEndianTime(t *testing.T) {
	pk := make([]byte, 65)
	pk[0] = 4
	var ts [8]byte
	binary.BigEndian.PutUint64(ts[:], 7)
	pre := []byte("coral-hub/device-keys/2/passkey-cert\x00cmp\x00lbl\x00")
	pre = append(append(append(pre, pk...), 0), ts[:]...)
	want := sha256.Sum256(pre)
	assert.Equal(t, want[:], devicekey.Challenge("cmp", "lbl", pk, 7))
}

func TestACertificateSignatureWithTrailingBytesIsRefused(t *testing.T) {
	r := newPkRig(t)
	dev := newSigner(t)
	c := r.cert(dev, nil)
	der, _ := b64.DecodeString(c.Signature)
	for len(der) > 71 { // one more byte must still fit the 72-byte cap, so it is the trailing byte that is refused
		c = r.cert(dev, nil)
		der, _ = b64.DecodeString(c.Signature)
	}
	c.Signature = b64.EncodeToString(append(der, 0))
	r.refused(devicekey.ErrBadSignature, c, dev, t0)
}

func TestACertificateNeverStartsAboveViewWhateverThePasskeyMode(t *testing.T) {
	r := newPkRig(t)
	require.NoError(t, r.ss.SetDeviceMode(context.Background(), r.passkey.kid, "interact", "", t0))
	dev := newSigner(t)
	require.NoError(t, r.handle(r.cert(dev, nil), t0))
	k, _ := r.listed(dev.kid)
	assert.Equal(t, "view", k.Mode)
}

func TestACertificateWithAnOriginWithAPortOrPathHubRecordIsRefused(t *testing.T) {
	r := newPkRig(t)
	for _, o := range []string{"http://app.coralhub.dev", hubOrigin + "/", hubOrigin + ":8443", "app.coralhub.dev"} {
		r.v.HubOrigin = o
		dev := newSigner(t)
		r.refused(devicekey.ErrBadSignature, r.cert(dev, &assertion{origin: o}), dev, t0)
	}
}

// Security's MUST (b): an accepted certificate is audited with the passkey's kid, the new device's kid and the mode; a refused one is not.
func TestACertificateIsAuditedOnlyWhenItAddsADevice(t *testing.T) {
	r := newPkRig(t)
	type row struct{ pk, dev, mode string }
	var rows []row
	r.v.AuditCert = func(p, d, m string) { rows = append(rows, row{p, d, m}) }
	bad := newSigner(t)
	c := r.cert(bad, nil)
	c.Signature = c.Signature[:len(c.Signature)-4] + "AAAA"
	assert.Error(t, r.handle(c, t0))
	assert.Empty(t, rows, "a refused certificate writes no audit row")
	dev := newSigner(t)
	require.NoError(t, r.handle(r.cert(dev, nil), t0))
	assert.Equal(t, []row{{r.passkey.kid, dev.kid, "view"}}, rows)
}
