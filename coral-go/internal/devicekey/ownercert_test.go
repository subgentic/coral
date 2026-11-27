package devicekey_test

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/json"
	"math/big"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Sign once (#21889): an owner certificate from the anchor passkey lets a browser sign the content kinds on every computer that listed the anchor, once the person at that computer pressed Keep.

const ocHubUser = "hub-user-0a1b2c3d"

type ocRig struct {
	*rig
	anchor  signer
	capMode tunnel.Mode
	capOn   bool
	seen    []bool
}

// newOCRig is a computer that knows the anchor (as the pairing made it) and accepts certified devices up to launch.
func newOCRig(t *testing.T, anchor signer) *ocRig {
	t.Helper()
	r := newRig(t)
	o := &ocRig{rig: r, anchor: anchor, capMode: tunnel.TierLaunch, capOn: true}
	r.v.HubOrigin = hubOrigin
	r.v.Owner = r.ss
	r.v.CertCap = func() (tunnel.Mode, bool) { return o.capMode, o.capOn }
	r.v.CertSeen = func(first bool, _ store.CertifiedDevice, _ string) { o.seen = append(o.seen, first) }
	raw, _ := b64.DecodeString(anchor.pk)
	ok, err := r.ss.SetOwnerAnchor(context.Background(), raw, "cred-1", false, t0.Add(-time.Hour))
	require.NoError(t, err)
	require.True(t, ok)
	return o
}

type ocOpts struct {
	mut       func(*devicekey.OwnerCert)
	signWith  *ecdsa.PrivateKey
	challenge []byte
}

// certHeader is the Coral-Device-Cert value the anchor's passkey would produce for dev.
func (o *ocRig) certHeader(dev signer, opts ocOpts) string {
	o.t.Helper()
	devRaw, _ := b64.DecodeString(dev.pk)
	c := devicekey.OwnerCert{OwnerKID: o.anchor.kid, Label: "Laptop", DevicePK: dev.pk, MaxMode: "launch", NotBefore: t0.Unix() - 60, NotAfter: t0.Unix() + 3600, Epoch: 1}
	if opts.mut != nil {
		opts.mut(&c)
	}
	ch := opts.challenge
	if ch == nil {
		ch = devicekey.OwnerCertChallenge(c, devRaw)
	}
	rp := sha256.Sum256([]byte("app.coralhub.dev"))
	ad := append(append([]byte{}, rp[:]...), 0x05, 0, 0, 0, 1)
	cd, err := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": b64.EncodeToString(ch), "origin": hubOrigin})
	require.NoError(o.t, err)
	cdh := sha256.Sum256(cd)
	h := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	key := opts.signWith
	if key == nil {
		key = o.anchor.priv
	}
	rr, ss, err := ecdsa.Sign(rand.Reader, key, h[:])
	require.NoError(o.t, err)
	der, err := asn1.Marshal(struct{ R, S *big.Int }{rr, ss})
	require.NoError(o.t, err)
	c.AuthenticatorData, c.ClientDataJSON, c.Signature = b64.EncodeToString(ad), b64.EncodeToString(cd), b64.EncodeToString(der)
	body, err := json.Marshal(map[string]any{"owner_kid": c.OwnerKID, "label": c.Label, "device_pk": c.DevicePK, "max_mode": c.MaxMode, "not_before": c.NotBefore, "not_after": c.NotAfter, "epoch": c.Epoch,
		"authenticator_data": c.AuthenticatorData, "client_data_json": c.ClientDataJSON, "signature": c.Signature})
	require.NoError(o.t, err)
	return b64.EncodeToString(body)
}

// send makes dev sign a request (kind, method, target, body) and hands it to the verifier with the certificate header.
func (o *ocRig) send(dev signer, cert string, k devicekey.Kind, method, target string, body []byte, now time.Time) (devicekey.Relayed, error) {
	o.t.Helper()
	m := devicekey.Relayed{Kind: k, KID: dev.kid, Computer: o.computer, Ts: now.Unix(), Nonce: o.nextNonce(), Link: "lnk_1", HubUser: ocHubUser, Method: method, Path: target, BodySHA256: devicekey.BodySHA256(body)}
	c, err := m.Canonical()
	require.NoError(o.t, err)
	return o.v.HandleRelayedRequest(context.Background(), devicekey.RelayedRequest{Link: "lnk_1", HubUser: ocHubUser, Method: method, Target: target, KID: dev.kid,
		Sig: dev.signRelayed(o.t, k, c), Ts: itoa(m.Ts), Nonce: m.Nonce, Cert: cert, Body: body}, func(string) (string, bool) { return ocHubUser, true }, now)
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

const ocSend = "/api/sessions/live/agent-1/send"

func (o *ocRig) sendToAgent(dev signer, cert string) (devicekey.Relayed, error) {
	return o.send(dev, cert, devicekey.SendToAgent, "POST", ocSend, []byte(`{"text":"go"}`), t0)
}

func (o *ocRig) keep(dev signer, mode string) {
	o.t.Helper()
	require.NoError(o.t, o.ss.KeepCertifiedDevice(context.Background(), dev.kid, mode, t0))
}

func TestACertifiedBrowserIsRefusedUntilThePersonKeepsIt(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, err := o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed, "at view, a send is above its mode")
	assert.Equal(t, []bool{true}, o.seen, "the first sight is told, so the person sees Keep and Remove")
	d, ok, _ := o.ss.CertifiedDeviceRow(context.Background(), dev.kid)
	require.True(t, ok)
	assert.Empty(t, d.KeptMode)

	o.keep(dev, "interact")
	m, err := o.sendToAgent(dev, cert)
	require.NoError(t, err)
	assert.Equal(t, dev.kid, m.KID)
	assert.Equal(t, []bool{true, false}, o.seen)
}

func TestACertificateIsGoodOnEveryComputerThatListedTheAnchor(t *testing.T) {
	anchor := newSigner(t)
	a, b := newOCRig(t, anchor), newOCRig(t, anchor)
	dev := newSigner(t)
	cert := a.certHeader(dev, ocOpts{}) // signed once, with no computer in it
	for _, o := range []*ocRig{a, b} {
		_, err := o.sendToAgent(dev, cert)
		require.ErrorIs(t, err, devicekey.ErrCertNotAllowed)
		o.keep(dev, "interact")
		_, err = o.sendToAgent(dev, cert)
		require.NoError(t, err)
	}
	c := newOCRig(t, newSigner(t)) // a computer that listed another anchor
	_, err := c.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature, "an owner this computer does not list reads like any bad signature")
}

func TestACertifiedBrowserSignsOnlyTheClosedListOfContentKinds(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, _ = o.sendToAgent(dev, cert)
	o.keep(dev, "launch")
	_, err := o.send(dev, cert, devicekey.KeepFullAccess, "POST", "/api/sessions/live/agent-1/keep-full-access", nil, t0)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed, "an admin kind is never signed by a certificate, even Kept at launch")
	_, err = o.send(dev, cert, devicekey.BoardPost, "POST", "/api/board/p/messages", []byte(`{"content":"hi"}`), t0)
	assert.NoError(t, err)
	// the list is closed and pinned: a kind added later is not on it until someone lists it here
	want := map[devicekey.Kind]bool{devicekey.SendToAgent: true, devicekey.BoardPost: true, devicekey.TrustPreview: true, devicekey.GuideRoster: true,
		devicekey.DailyKnowledgeTeam: true, devicekey.DailyKnowledgeAutoApply: true, devicekey.DailyKnowledgeAccept: true, devicekey.DailyKnowledgeRevert: true}
	assert.Equal(t, want, devicekey.CertifiedKinds)
	for _, k := range devicekey.RelayedKinds {
		if !want[k] {
			assert.False(t, devicekey.CertifiedKinds[k], string(k))
		}
	}
}

func TestACertificateIsRefusedWhileTheSettingIsOffAndNeverAboveIt(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, _ = o.sendToAgent(dev, cert)
	o.keep(dev, "launch")
	o.capOn = false
	_, err := o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed, "off is the default")
	o.capOn, o.capMode = true, tunnel.TierView
	_, err = o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed, "the computer's own setting caps the mode: view cannot send")
	o.capMode = tunnel.TierInteract
	_, err = o.sendToAgent(dev, cert)
	assert.NoError(t, err)
}

func TestACertificateOutsideItsValidityIsCertExpired(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	expired := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.NotBefore, c.NotAfter = t0.Unix()-7200, t0.Unix()-60 }})
	_, err := o.sendToAgent(dev, expired)
	assert.ErrorIs(t, err, devicekey.ErrCertExpired)
	early := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.NotBefore, c.NotAfter = t0.Unix()+3600, t0.Unix()+7200 }})
	_, err = o.sendToAgent(dev, early)
	assert.ErrorIs(t, err, devicekey.ErrCertExpired, "not yet valid reads the same: check the clock")
}

func TestACertificateBelowTheStoredEpochIsRefusedAndTheEpochNeverGoesDown(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	require.NoError(t, o.ss.RaiseOwnerEpoch(context.Background(), o.anchor.kid, 5, t0))
	_, err := o.sendToAgent(dev, o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.Epoch = 4 }}))
	assert.ErrorIs(t, err, devicekey.ErrCertEpoch)
	_, err = o.sendToAgent(dev, o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.Epoch = 5 }}))
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed, "an equal epoch passes the check (and then waits for Keep)")
}

func TestARemovedCertifiedBrowserStaysRefusedWhateverCertificateItBrings(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, _ = o.sendToAgent(dev, cert)
	o.keep(dev, "interact")
	_, err := o.sendToAgent(dev, cert)
	require.NoError(t, err)
	require.NoError(t, o.ss.DenyCertifiedDevice(context.Background(), dev.kid, "Laptop", t0))
	_, err = o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed)
	fresh := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.Epoch = 9 }}) // a new certificate does not undo a local Remove
	_, err = o.sendToAgent(dev, fresh)
	assert.ErrorIs(t, err, devicekey.ErrCertNotAllowed)
	require.NoError(t, o.ss.RemoveOwnerAnchor(context.Background()))
	d, _, _ := o.ss.CertifiedDeviceRow(context.Background(), dev.kid)
	assert.NotZero(t, d.DeniedAt, "the deny outlives the anchor")
}

func TestReplacingTheAnchorDropsEveryKeep(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, _ = o.sendToAgent(dev, cert)
	o.keep(dev, "interact")
	other := newSigner(t)
	raw, _ := b64.DecodeString(other.pk)
	ok, err := o.ss.SetOwnerAnchor(context.Background(), raw, "cred-2", true, t0)
	require.NoError(t, err)
	require.True(t, ok)
	_, err = o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature, "the old anchor is not this computer's any more")
	d, _, _ := o.ss.CertifiedDeviceRow(context.Background(), dev.kid)
	assert.Empty(t, d.KeptMode)
}

func TestARefusedCertificateSpendsNoNonceAndATamperedOneIsBadSignature(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	other := newSigner(t) // not the anchor
	_, err := o.sendToAgent(dev, o.certHeader(dev, ocOpts{signWith: other.priv}))
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
	_, err = o.sendToAgent(dev, o.certHeader(dev, ocOpts{challenge: make([]byte, 32)}))
	assert.ErrorIs(t, err, devicekey.ErrBadSignature, "a challenge that is not the certificate's own")
	// the field the signature covers cannot be changed after it was signed: another max_mode under the same assertion
	good := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.MaxMode = "view" }})
	raw, _ := b64.DecodeString(good)
	var m map[string]any
	require.NoError(t, json.Unmarshal(raw, &m))
	m["max_mode"] = "launch"
	swapped, _ := json.Marshal(m)
	_, err = o.sendToAgent(dev, b64.EncodeToString(swapped))
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
}

func TestACertificateIsBadFormWhenOversizedLongLivedOrNotTheDevicesOwn(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	_, err := o.sendToAgent(dev, b64.EncodeToString(make([]byte, devicekey.CertHeaderMax)))
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "over the header cap")
	_, err = o.sendToAgent(dev, "not base64 json")
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
	long := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.NotAfter = c.NotBefore + 25*3600 }})
	_, err = o.sendToAgent(dev, long)
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "above view a certificate lives at most 24 hours")
	viewWeek := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.MaxMode = "view"; c.NotAfter = c.NotBefore + 6*24*3600 }})
	_, err = o.sendToAgent(dev, viewWeek)
	assert.NotErrorIs(t, err, devicekey.ErrBadForm, "a view certificate may live a week")
	notMine := o.certHeader(newSigner(t), ocOpts{}) // a certificate for another browser's key
	_, err = o.sendToAgent(dev, notMine)
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
	upper := o.certHeader(dev, ocOpts{mut: func(c *devicekey.OwnerCert) { c.MaxMode = "Launch" }})
	_, err = o.sendToAgent(dev, upper)
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "the mode word is exact")
}

func TestACertifiedBrowserNeverActsOnTheAdminMessages(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	_, _ = o.sendToAgent(dev, o.certHeader(dev, ocOpts{}))
	o.keep(dev, "launch")
	target := newSigner(t)
	m := o.msg(devicekey.ApproveDevice, dev)
	m.TargetKID, m.TargetPK, m.Mode, m.Label = target.kid, target.pk, "view", "x"
	body, err := m.Canonical()
	require.NoError(t, err)
	_, err = o.v.Handle(context.Background(), devicekey.ApproveDevice, body, dev.sign(t, devicekey.ApproveDevice, body), t0)
	assert.Error(t, err, "M5: a certificate never makes a signer for approve-device, raise-mode, trust-passkey or remove")
}

func TestACertificateIsVerifiedOncePerCertificateAndTheNoncePoolIsItsOwn(t *testing.T) {
	o := newOCRig(t, newSigner(t))
	dev := newSigner(t)
	cert := o.certHeader(dev, ocOpts{})
	_, _ = o.sendToAgent(dev, cert)
	o.keep(dev, "interact")
	for i := 0; i < store.CertNonceKidShare; i++ {
		_, err := o.sendToAgent(dev, cert)
		require.NoError(t, err, i)
	}
	_, err := o.sendToAgent(dev, cert)
	assert.ErrorIs(t, err, devicekey.ErrNonceStoreFull, "a full pool refuses the new certified message")
	// the owner's own device key has its own pool and is not crowded out
	m := o.relayedMsg(devicekey.SendToAgent, o.signer, nil)
	m.Path, m.Method = ocSend, "POST"
	c, _ := m.Canonical()
	_, err = o.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", ocSend, m.Kind, c, nil, o.signer.signRelayed(t, m.Kind, c), t0, allow)
	assert.NoError(t, err)
}

func TestACertificateHeaderIsParsedStrictly(t *testing.T) {
	_, err := devicekey.ParseOwnerCert("")
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	_ = k
	raw := b64.EncodeToString([]byte(`{"owner_kid":"x"}`))
	_, err = devicekey.ParseOwnerCert(raw)
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "missing keys")
	dup := b64.EncodeToString([]byte(`{"owner_kid":"a","owner_kid":"b"}`))
	_, err = devicekey.ParseOwnerCert(dup)
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
}
