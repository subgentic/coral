package devicekey_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// #20515: Security's M3 to M6 and SHOULDs on the device-signing read (#20514).

type audited struct {
	a                     devicekey.Action
	signer, target, tmode string
}

func TestEveryAppliedMessageIsAuditedAndApprovedByIsRecorded(t *testing.T) {
	r := newRig(t)
	var log []audited
	r.v.Audit = func(a devicekey.Action, s, tg, m string) { log = append(log, audited{a, s, tg, m}) }
	target := newSigner(t)
	_, err := r.handle(r.approve(r.signer, target, "view"), r.signer, t0)
	require.NoError(t, err)
	k, _ := r.listed(target.kid)
	assert.Equal(t, r.signer.kid, k.ApprovedBy, "the new row says who approved it")

	_, err = r.handle(r.raise(r.signer, target.kid, "interact"), r.signer, t0)
	require.NoError(t, err)
	f := fixture(t)
	tp := r.msg(devicekey.TrustPasskey, r.signer)
	tp.PasskeyPK, tp.Label = f.passkeyPK, "Phone"
	_, err = r.handle(tp, r.signer, t0)
	require.NoError(t, err)
	pk, _ := r.listed(kidOf(f.passkeyPK))
	assert.Equal(t, r.signer.kid, pk.ApprovedBy)
	_, err = r.handle(r.remove(r.signer, target.kid), r.signer, t0)
	require.NoError(t, err)

	require.Len(t, log, 4)
	assert.Equal(t, audited{devicekey.ApproveDevice, r.signer.kid, target.kid, "view"}, log[0])
	assert.Equal(t, audited{devicekey.RaiseMode, r.signer.kid, target.kid, "interact"}, log[1])
	assert.Equal(t, audited{devicekey.TrustPasskey, r.signer.kid, kidOf(f.passkeyPK), "view"}, log[2])
	assert.Equal(t, devicekey.RemoveDevice, log[3].a)
}

func TestARefusedMessageIsNotAudited(t *testing.T) {
	r := newRig(t)
	n := 0
	r.v.Audit = func(devicekey.Action, string, string, string) { n++ }
	r.v.Notice = func(devicekey.Notice) { n++ }
	r.refused(devicekey.ErrBadMode, r.approve(r.signer, newSigner(t), "bogus"), r.signer, t0)
	assert.Zero(t, n)
}

func TestTheOwnerIsToldWithTheNewKeysFingerprint(t *testing.T) {
	r := newRig(t)
	var got []devicekey.Notice
	r.v.Notice = func(n devicekey.Notice) { got = append(got, n) }
	a := newSigner(t)
	r.addPaired(a, "launch", linkA, userA)
	target := newSigner(t)
	require.NoError(t, r.handleOn(linkA, r.approve(a, target, "view"), a))
	raw, _ := b64.DecodeString(target.pk)
	require.Len(t, got, 1)
	n := got[0]
	assert.Equal(t, devicekey.ApproveDevice, n.Action)
	assert.Equal(t, devicekey.DisplayFingerprint(raw), n.Fingerprint, "from the key's own bytes, in the grouping the pairing screen shows")
	assert.Regexp(t, `^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$`, n.Fingerprint)
	assert.Equal(t, a.kid, n.SignerKID)
	assert.Equal(t, [2]string{linkA, userA}, [2]string{n.Link, n.HubUser})

	require.NoError(t, r.handleOn(linkA, r.raise(a, target.kid, "interact"), a))
	require.Len(t, got, 2)
	assert.Equal(t, devicekey.RaiseMode, got[1].Action)
	assert.Equal(t, n.Fingerprint, got[1].Fingerprint, "a raise names the same key")
	assert.Equal(t, "interact", got[1].Mode)

	f := fixture(t)
	tp := r.msg(devicekey.TrustPasskey, a)
	tp.PasskeyPK, tp.Label = f.passkeyPK, "Phone"
	require.NoError(t, r.handleOn(linkA, tp, a))
	require.Len(t, got, 3)
	pkRaw, _ := b64.DecodeString(f.passkeyPK)
	assert.Equal(t, devicekey.DisplayFingerprint(pkRaw), got[2].Fingerprint)

	require.NoError(t, r.handleOn(linkA, r.remove(a, target.kid), a))
	assert.Len(t, got, 3, "a removal is audited, not a notice")
}

func TestADeviceAPasskeyCertifiedActsOnlyOnItself(t *testing.T) {
	r := newRig(t)
	cert, victim, other := newSigner(t), newSigner(t), newSigner(t)
	r.add(victim, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	raw, _ := b64.DecodeString(cert.pk)
	_, err := r.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: cert.kid, PK: raw, Label: "c", Mode: "interact", Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice,
		Link: store.PairOwner, HubUser: store.PairOwner, ApprovedBy: "PASSKEY", ViaPasskey: "PASSKEY"}, t0.Add(-time.Hour))
	require.NoError(t, err)
	r.refused(devicekey.ErrSignerNoProof, r.approve(cert, other, "view"), cert, t0)
	r.refused(devicekey.ErrSignerNoProof, r.raise(cert, victim.kid, "interact"), cert, t0)
	r.refused(devicekey.ErrSignerNoProof, r.remove(cert, victim.kid), cert, t0)
	f := fixture(t)
	tp := r.msg(devicekey.TrustPasskey, cert)
	tp.PasskeyPK, tp.Label = f.passkeyPK, "P"
	r.refused(devicekey.ErrSignerNoProof, tp, cert, t0)
	_, err = r.handle(r.remove(cert, cert.kid), cert, t0)
	assert.NoError(t, err, "it may remove itself")
}

func TestARelayedMessageHasFiveMinutesWhateverItsAction(t *testing.T) {
	for _, a := range []devicekey.Action{devicekey.RemoveDevice, devicekey.TrustPasskey} {
		r := newRig(t)
		build := func() devicekey.Message {
			if a == devicekey.RemoveDevice {
				target := newSigner(t)
				r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
				return r.remove(r.signer, target.kid)
			}
			m := r.msg(a, r.signer)
			m.PasskeyPK, m.Label = fixture(t).passkeyPK, "P"
			return m
		}
		old := build()
		body, _ := old.Canonical()
		_, err := r.v.HandleOn(context.Background(), "lnk_1", a, body, r.signer.sign(t, a, body), t0.Add(5*time.Minute+time.Second))
		assert.ErrorIs(t, err, devicekey.ErrTsWindow, "via a link: five minutes (%s)", a)
		// the same message without a link (a local call) keeps the step-2 window
		fresh := build()
		body, _ = fresh.Canonical()
		_, err = r.v.HandleOn(context.Background(), "", a, body, r.signer.sign(t, a, body), t0.Add(time.Hour))
		assert.NoError(t, err, "no link: a day (%s)", a)
	}
}

func TestAKeyAPersonRemovedIsNotApprovedAgainButAnExpiredOneMayBe(t *testing.T) {
	r := newRig(t)
	gone, lapsed := newSigner(t), newSigner(t)
	r.add(gone, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.add(lapsed, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	ctx := context.Background()
	require.NoError(t, r.ss.RemoveDeviceKey(ctx, gone.kid, store.DeviceRemoved, t0))
	require.NoError(t, r.ss.RemoveDeviceKey(ctx, lapsed.kid, store.DeviceExpired, t0))
	r.refused(devicekey.ErrBadForm, r.approve(r.signer, gone, "view"), r.signer, t0)
	_, err := r.handle(r.approve(r.signer, lapsed, "view"), r.signer, t0)
	assert.NoError(t, err)
}

func TestAPeerAtTheSameModeIsNotRemovedExceptAtTheTopModeByTheOwnersDevice(t *testing.T) {
	r := newRig(t)
	a, b, c := newSigner(t), newSigner(t), newSigner(t)
	r.add(a, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.add(b, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.add(c, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrAboveSigner, r.remove(a, b.kid), a, t0)
	_, err := r.handle(r.remove(a, c.kid), a, t0)
	assert.NoError(t, err, "a lower one is removed")
	_, err = r.handle(r.remove(b, b.kid), b, t0)
	assert.NoError(t, err, "itself, always")
}
