package devicekey_test

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The verifier (#19669 slice 3): one failing-first test per refusal code of design page section 4. Time is passed in; Coral's clock is the only clock.

var t0 = time.Unix(1_800_000_000, 0)

type signer struct {
	priv *ecdsa.PrivateKey
	pk   string
	kid  string
}

func newSigner(t *testing.T) signer {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	e, err := priv.ECDH()
	require.NoError(t, err)
	pk := b64.EncodeToString(e.PublicKey().Bytes())
	return signer{priv: priv, pk: pk, kid: kidOf(pk)}
}

// sign makes the P1363 signature, base64url, over the signing input.
func (s signer) sign(t *testing.T, a devicekey.Action, body []byte) string {
	t.Helper()
	h := sha256.Sum256(devicekey.SigningInput(a, body))
	r, ss, err := ecdsa.Sign(rand.Reader, s.priv, h[:])
	require.NoError(t, err)
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	ss.FillBytes(sig[32:])
	return b64.EncodeToString(sig)
}

type rig struct {
	t        *testing.T
	ss       *store.SessionStore
	v        *devicekey.Verifier
	computer string
	signer   signer // a paired device at mode launch (the top mode)
	nonce    int
}

func newRig(t *testing.T) *rig {
	t.Helper()
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	x, err := ecdh.X25519().GenerateKey(rand.Reader)
	require.NoError(t, err)
	r := &rig{t: t, ss: ss, computer: devicekey.ComputerFingerprint(x.PublicKey().Bytes()), signer: newSigner(t)}
	r.v = &devicekey.Verifier{Store: ss, Computer: r.computer}
	r.add(r.signer, "launch", store.DeviceOriginPairing, store.DeviceKindDevice)
	return r
}

func (r *rig) add(s signer, mode, origin, kind string) {
	r.t.Helper()
	raw, _ := b64.DecodeString(s.pk)
	_, err := r.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: s.kid, PK: raw, Label: "dev", Mode: mode, Origin: origin, Kind: kind}, t0.Add(-time.Hour))
	require.NoError(r.t, err)
}

func (r *rig) nextNonce() string {
	r.nonce++
	b := make([]byte, 16)
	b[0], b[1] = byte(r.nonce), byte(r.nonce>>8)
	return b64.EncodeToString(b)
}

// msg builds a message from a signer for an action, with this rig's computer and a fresh nonce.
func (r *rig) msg(a devicekey.Action, s signer) devicekey.Message {
	return devicekey.Message{Action: a, KID: s.kid, Computer: r.computer, Ts: t0.Unix(), Nonce: r.nextNonce()}
}

// handle signs with s and runs the message through the verifier at now.
func (r *rig) handle(m devicekey.Message, s signer, now time.Time) (devicekey.Message, error) {
	r.t.Helper()
	body, err := m.Canonical()
	require.NoError(r.t, err)
	return r.v.Handle(context.Background(), m.Action, body, s.sign(r.t, m.Action, body), now)
}

func (r *rig) approve(s signer, target signer, mode string) devicekey.Message {
	m := r.msg(devicekey.ApproveDevice, s)
	m.TargetKID, m.TargetPK, m.Label, m.Mode = target.kid, target.pk, "New phone", mode
	return m
}

func (r *rig) raise(s signer, targetKID, mode string) devicekey.Message {
	m := r.msg(devicekey.RaiseMode, s)
	m.TargetKID, m.Mode = targetKID, mode
	return m
}

func (r *rig) remove(s signer, targetKID string) devicekey.Message {
	m := r.msg(devicekey.RemoveDevice, s)
	m.TargetKID = targetKID
	return m
}

func (r *rig) listed(kid string) (store.DeviceKey, bool) {
	l, _ := r.ss.ListDeviceKeys(context.Background())
	for _, k := range l {
		if k.KID == kid {
			return k, true
		}
	}
	return store.DeviceKey{}, false
}

// ---- the happy paths: each action does what it says, and only after the checks ----

func TestApproveDeviceAddsAPairedDeviceAtTheAskedMode(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	_, err := r.handle(r.approve(r.signer, target, "interact"), r.signer, t0)
	require.NoError(t, err)
	k, ok := r.listed(target.kid)
	require.True(t, ok)
	assert.Equal(t, "interact", k.Mode)
	assert.Equal(t, store.DeviceOriginPairing, k.Origin, "a signed approval is the proof")
	assert.Equal(t, store.DeviceKindDevice, k.Kind)
	assert.Equal(t, "New phone", k.Label)
}

func TestRaiseModeChangesTheTargetsMode(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	_, err := r.handle(r.raise(r.signer, target.kid, "interact"), r.signer, t0)
	require.NoError(t, err)
	k, _ := r.listed(target.kid)
	assert.Equal(t, "interact", k.Mode)
}

func TestRemoveDeviceRemoves(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	_, err := r.handle(r.remove(r.signer, target.kid), r.signer, t0)
	require.NoError(t, err)
	_, err = r.ss.ActiveDeviceKey(context.Background(), target.kid, t0)
	assert.ErrorIs(t, err, store.ErrSignerRemoved)
}

func TestTrustPasskeyAddsAPasskeyAtTheLowestMode(t *testing.T) {
	r := newRig(t)
	pk := newSigner(t)
	m := r.msg(devicekey.TrustPasskey, r.signer)
	m.PasskeyPK, m.Label = pk.pk, "Work phone"
	_, err := r.handle(m, r.signer, t0)
	require.NoError(t, err)
	k, ok := r.listed(pk.kid)
	require.True(t, ok)
	assert.Equal(t, store.DeviceKindPasskey, k.Kind)
	assert.Equal(t, "view", k.Mode)
}

func TestAnAcceptedMessageTouchesTheSigner(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	_, err := r.handle(r.approve(r.signer, target, "view"), r.signer, t0)
	require.NoError(t, err)
	k, _ := r.listed(r.signer.kid)
	assert.Equal(t, t0.Unix(), k.LastUsedAt)
}

// ---- one test per refusal code; a refusal changes nothing: no nonce, no touch, no list change ----

// refused runs the message and expects the code, then proves nothing was kept: the same message with the same nonce, once the cause is gone, is not a repeat.
func (r *rig) refused(want error, m devicekey.Message, s signer, now time.Time) {
	r.t.Helper()
	before, _ := r.ss.ListDeviceKeys(context.Background())
	_, err := r.handle(m, s, now)
	assert.ErrorIs(r.t, err, want)
	after, _ := r.ss.ListDeviceKeys(context.Background())
	assert.Equal(r.t, before, after, "a refused message changes no key, no mode and no last-used time")
	assert.NotErrorIs(r.t, r.ss.RecordNonce(context.Background(), m.Nonce, "probe", now, time.Minute), store.ErrNonceRepeat, "a refused message recorded no nonce")
}

func TestBadForm(t *testing.T) {
	r := newRig(t)
	m := r.remove(r.signer, newSigner(t).kid)
	body, _ := m.Canonical()
	spaced := append([]byte(nil), body...)
	spaced = append(spaced[:1], append([]byte(" "), spaced[1:]...)...)
	_, err := r.v.Handle(context.Background(), m.Action, spaced, r.signer.sign(t, m.Action, spaced), t0)
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
}

func TestWrongComputer(t *testing.T) {
	r := newRig(t)
	m := r.remove(r.signer, newSigner(t).kid)
	m.Computer = devicekey.ComputerFingerprint([]byte("another computer's 32 byte key!!"))
	r.refused(devicekey.ErrWrongComputer, m, r.signer, t0)
}

func TestTsWindowFiveMinutesEitherSideForApproveAndRaise(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	for _, a := range []func(int64) devicekey.Message{
		func(ts int64) devicekey.Message { // a raise goes strictly up, so each one has its own view target
			t2 := newSigner(t)
			r.add(t2, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
			m := r.raise(r.signer, t2.kid, "interact")
			m.Ts = ts
			return m
		},
		func(ts int64) devicekey.Message { m := r.approve(r.signer, newSigner(t), "view"); m.Ts = ts; return m },
	} {
		now := t0.Add(time.Hour)
		r.refused(devicekey.ErrTsWindow, a(now.Add(-5*time.Minute-time.Second).Unix()), r.signer, now)
		r.refused(devicekey.ErrTsWindow, a(now.Add(5*time.Minute+time.Second).Unix()), r.signer, now)
		_, err := r.handle(a(now.Add(-5*time.Minute).Unix()), r.signer, now)
		assert.NoError(t, err, "exactly five minutes old is inside")
		_, err = r.handle(a(now.Add(5*time.Minute).Unix()), r.signer, now)
		assert.NoError(t, err, "exactly five minutes ahead is inside")
	}
}

func TestTsWindowTwentyFourHoursForRemoveAndPasskey(t *testing.T) {
	r := newRig(t)
	now := t0.Add(48 * time.Hour)
	old := func(d time.Duration) devicekey.Message {
		m := r.remove(r.signer, newSigner(t).kid)
		m.Ts = now.Add(-d).Unix()
		return m
	}
	r.refused(devicekey.ErrTsWindow, old(24*time.Hour+time.Second), r.signer, now)
	// inside the day the window check passes (the target is unknown, which is a later check)
	_, err := r.handle(old(23*time.Hour), r.signer, now)
	assert.ErrorIs(t, err, devicekey.ErrUnknownTarget, "past the window check")
	m := r.msg(devicekey.TrustPasskey, r.signer)
	m.PasskeyPK, m.Label, m.Ts = newSigner(t).pk, "p", now.Add(-24*time.Hour-time.Second).Unix()
	r.refused(devicekey.ErrTsWindow, m, r.signer, now)
}

func TestBeforeStart(t *testing.T) {
	r := newRig(t)
	r.v.RefuseBefore = t0.Add(time.Minute)
	m := r.remove(r.signer, newSigner(t).kid)
	m.Ts = t0.Unix()
	r.refused(devicekey.ErrBeforeStart, m, r.signer, t0.Add(time.Minute))
}

func TestClockBack(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	first := r.raise(r.signer, target.kid, "interact")
	first.Ts = t0.Add(time.Hour).Unix()
	_, err := r.handle(first, r.signer, t0.Add(time.Hour)) // makes the mark t0+1h
	require.NoError(t, err)
	m := r.raise(r.signer, target.kid, "view")
	m.Ts = t0.Unix()
	r.refused(devicekey.ErrClockBack, m, r.signer, t0)
}

func TestUnknownSigner(t *testing.T) {
	r := newRig(t)
	stranger := newSigner(t)
	r.refused(devicekey.ErrUnknownSigner, r.remove(stranger, r.signer.kid), stranger, t0)
}

func TestSignerRemovedAndAPurgedSignerIsUnknown(t *testing.T) {
	r := newRig(t)
	gone := newSigner(t)
	r.add(gone, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	require.NoError(t, r.ss.RemoveDeviceKey(context.Background(), gone.kid, store.DeviceRemoved, t0.Add(-time.Minute)))
	r.refused(devicekey.ErrSignerRemoved, r.remove(gone, r.signer.kid), gone, t0)
	_, err := r.ss.PurgeDeviceKeys(context.Background(), t0.Add(91*24*time.Hour))
	require.NoError(t, err)
	m := r.remove(gone, r.signer.kid)
	m.Ts = t0.Add(91 * 24 * time.Hour).Unix()
	r.refused(devicekey.ErrUnknownSigner, m, gone, t0.Add(91*24*time.Hour))
}

func TestSignerIdleExpiredIsRefused(t *testing.T) {
	r := newRig(t)
	now := t0.Add(100 * 24 * time.Hour)
	m := r.remove(r.signer, newSigner(t).kid)
	m.Ts = now.Unix()
	r.refused(devicekey.ErrSignerRemoved, m, r.signer, now)
}

func TestBadSignature(t *testing.T) {
	r := newRig(t)
	m := r.remove(r.signer, newSigner(t).kid)
	body, _ := m.Canonical()
	good := r.signer.sign(t, m.Action, body)
	other := newSigner(t).sign(t, m.Action, body) // a different key's signature
	wrongAction := r.signer.sign(t, devicekey.RaiseMode, body)
	for name, sig := range map[string]string{"another key": other, "another action": wrongAction, "empty": "", "short": good[:80], "not base64url": good[:85] + "+", "padded": good + "="} {
		_, err := r.v.Handle(context.Background(), m.Action, body, sig, t0)
		assert.ErrorIs(t, err, devicekey.ErrBadSignature, name)
	}
	_, err := r.v.Handle(context.Background(), m.Action, append(body[:len(body)-2:len(body)-2], "x\"}"...), good, t0)
	assert.Error(t, err, "a body changed after signing")
}

func TestBadSignatureLeavesNoTrace(t *testing.T) {
	r := newRig(t)
	m := r.remove(r.signer, newSigner(t).kid)
	body, _ := m.Canonical()
	_, err := r.v.Handle(context.Background(), m.Action, body, newSigner(t).sign(t, m.Action, body), t0)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
	k, _ := r.listed(r.signer.kid)
	assert.Zero(t, k.LastUsedAt, "an unsigned or badly signed request never touches the signer (Lead's note C)")
	assert.NoError(t, r.ss.RecordNonce(context.Background(), m.Nonce, "probe", t0, time.Minute))
}

func TestSignerBootstrapCannotApproveOrRaise(t *testing.T) {
	r := newRig(t)
	boot := newSigner(t)
	r.add(boot, "interact", store.DeviceOriginBootstrap, store.DeviceKindDevice)
	other := newSigner(t)
	r.add(other, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrSignerBootstrap, r.approve(boot, newSigner(t), "view"), boot, t0)
	r.refused(devicekey.ErrSignerBootstrap, r.raise(boot, other.kid, "interact"), boot, t0)
}

func TestSignerNoProofCannotAddPassKeysOrApprove(t *testing.T) {
	r := newRig(t)
	np := newSigner(t)
	r.add(np, "interact", store.DeviceOriginNoProof, store.DeviceKindDevice)
	m := r.msg(devicekey.TrustPasskey, np)
	m.PasskeyPK, m.Label = newSigner(t).pk, "p"
	r.refused(devicekey.ErrSignerNoProof, m, np, t0)
	r.refused(devicekey.ErrSignerNoProof, r.approve(np, newSigner(t), "view"), np, t0)
}

func TestTopModeIsNeverSetByASignedMessage(t *testing.T) {
	r := newRig(t) // the signer is at launch, the top mode: even so, a signed message cannot make launch
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrTopMode, r.raise(r.signer, target.kid, "launch"), r.signer, t0)
	r.refused(devicekey.ErrTopMode, r.approve(r.signer, newSigner(t), "launch"), r.signer, t0)
}

func TestAboveSignerIsRefused(t *testing.T) {
	r := newRig(t)
	low := newSigner(t)
	r.add(low, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrAboveSigner, r.raise(low, target.kid, "interact"), low, t0)
	r.refused(devicekey.ErrAboveSigner, r.approve(low, newSigner(t), "interact"), low, t0)
	_, err := r.handle(r.approve(low, newSigner(t), "view"), low, t0)
	assert.NoError(t, err, "up to the signer's own mode is allowed")
}

func TestSignerModeIsReadFromTheListNotTheBody(t *testing.T) {
	r := newRig(t)
	low := newSigner(t)
	r.add(low, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	// nothing in a body names the signer's mode; lowering it in the list lowers what the signer can do at once
	require.NoError(t, r.ss.SetDeviceMode(context.Background(), r.signer.kid, "view", t0))
	r.refused(devicekey.ErrAboveSigner, r.approve(r.signer, newSigner(t), "interact"), r.signer, t0)
}

func TestSelfTarget(t *testing.T) {
	r := newRig(t)
	r.refused(devicekey.ErrSelfTarget, r.raise(r.signer, r.signer.kid, "interact"), r.signer, t0)
	r.refused(devicekey.ErrSelfTarget, r.approve(r.signer, r.signer, "view"), r.signer, t0)
	boot := newSigner(t)
	r.add(boot, "view", store.DeviceOriginBootstrap, store.DeviceKindDevice)
	r.refused(devicekey.ErrTargetBootstrap, r.raise(r.signer, boot.kid, "interact"), r.signer, t0) // a bootstrap device stays capped until a real pairing
}

func TestUnknownTarget(t *testing.T) {
	r := newRig(t)
	r.refused(devicekey.ErrUnknownTarget, r.raise(r.signer, newSigner(t).kid, "interact"), r.signer, t0)
	r.refused(devicekey.ErrUnknownTarget, r.remove(r.signer, newSigner(t).kid), r.signer, t0)
}

func TestBadMode(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrBadMode, r.raise(r.signer, target.kid, "write"), r.signer, t0)
}

func TestNonceRepeat(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	m := r.raise(r.signer, target.kid, "interact")
	_, err := r.handle(m, r.signer, t0)
	require.NoError(t, err)
	body, _ := m.Canonical()
	_, err = r.v.Handle(context.Background(), m.Action, body, r.signer.sign(t, m.Action, body), t0.Add(time.Minute))
	assert.ErrorIs(t, err, devicekey.ErrNonceRepeat, "a replay inside the window")
}

func TestNonceRepeatSurvivesARestart(t *testing.T) {
	path := t.TempDir() + "/s.db"
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	s, target := newSigner(t), newSigner(t)
	for i, k := range []signer{s, target} {
		raw, _ := b64.DecodeString(k.pk)
		mode := []string{"interact", "view"}[i]
		_, err = ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: k.kid, PK: raw, Label: "d", Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice}, t0.Add(-time.Hour))
		require.NoError(t, err)
	}
	comp := devicekey.ComputerFingerprint([]byte("0123456789abcdef0123456789abcdef"))
	m := devicekey.Message{Action: devicekey.RaiseMode, KID: s.kid, Computer: comp, Ts: t0.Unix(), Nonce: b64.EncodeToString(make([]byte, 16)), TargetKID: target.kid, Mode: "interact"}
	body, _ := m.Canonical()
	sig := s.sign(t, m.Action, body)
	_, err = (&devicekey.Verifier{Store: ss, Computer: comp}).Handle(context.Background(), m.Action, body, sig, t0)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	db2, err := storetest.Open(t, path)
	require.NoError(t, err)
	_, err = (&devicekey.Verifier{Store: store.NewSessionStore(db2), Computer: comp}).Handle(context.Background(), m.Action, body, sig, t0.Add(time.Minute))
	assert.ErrorIs(t, err, devicekey.ErrNonceRepeat, "a captured message replayed after a restart, inside its window")
}

func TestNonceStoreFullIsPerSigner(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	other := newSigner(t)
	r.add(other, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	// one signer fills its share (1000 live nonces) directly in the store
	for i := 0; i < 1000; i++ {
		n := make([]byte, 16)
		n[0], n[1], n[2] = byte(i), byte(i>>8), 0xAA
		require.NoError(t, r.ss.RecordNonce(context.Background(), b64.EncodeToString(n), r.signer.kid, t0, 24*time.Hour))
	}
	r.refused(devicekey.ErrNonceStoreFull, r.raise(r.signer, target.kid, "interact"), r.signer, t0)
	_, err := r.handle(r.raise(other, target.kid, "interact"), other, t0)
	assert.NoError(t, err, "one signer at its share does not block the others")
}

func TestKeyLimitOnApprove(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 9; i++ { // the signer is the 1st of 10
		_, err := r.handle(r.approve(r.signer, newSigner(t), "view"), r.signer, t0)
		require.NoError(t, err)
	}
	// key_limit is the one refusal that comes after the checks and the nonce: the message was good and signed, so its nonce is spent (it cannot be replayed once a slot frees) and the list is unchanged.
	before, _ := r.ss.ListDeviceKeys(context.Background())
	m := r.approve(r.signer, newSigner(t), "view")
	_, err := r.handle(m, r.signer, t0)
	assert.ErrorIs(t, err, devicekey.ErrKeyLimit)
	after, _ := r.ss.ListDeviceKeys(context.Background())
	assert.Len(t, after, len(before), "nothing was added")
	assert.ErrorIs(t, r.ss.RecordNonce(context.Background(), m.Nonce, "probe", t0, time.Minute), store.ErrNonceRepeat, "the nonce is spent")
}

func TestRemoveOfAnAlreadyRemovedTargetIsUnknownTargetAndOneMayRemoveOneself(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	_, err := r.handle(r.remove(r.signer, target.kid), r.signer, t0)
	require.NoError(t, err)
	r.refused(devicekey.ErrUnknownTarget, r.remove(r.signer, target.kid), r.signer, t0)
	_, err = r.handle(r.remove(r.signer, r.signer.kid), r.signer, t0)
	assert.NoError(t, err, "a device may remove itself")
}

// A passkey signs with WebAuthn (slice 6), not with a plain P1363 signature: such a row is no signer here.
func TestAPasskeyRowIsNotASignerOfTheseMessages(t *testing.T) {
	r := newRig(t)
	pk := newSigner(t)
	r.add(pk, "view", store.DeviceOriginPairing, store.DeviceKindPasskey)
	r.refused(devicekey.ErrUnknownSigner, r.remove(pk, r.signer.kid), pk, t0)
}

// Security's MUST on slice 3: a bootstrap-origin signer cannot add a passkey (threat table).
func TestSignerBootstrapCannotTrustAPasskey(t *testing.T) {
	r := newRig(t)
	boot := newSigner(t)
	r.add(boot, "interact", store.DeviceOriginBootstrap, store.DeviceKindDevice)
	m := r.msg(devicekey.TrustPasskey, boot)
	m.PasskeyPK, m.Label = newSigner(t).pk, "p"
	r.refused(devicekey.ErrSignerBootstrap, m, boot, t0)
}

// Security's SHOULD 5: two Handle calls with the same message at once accept exactly one.
func TestHandleIsSerialized(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	m := r.raise(r.signer, target.kid, "interact")
	body, _ := m.Canonical()
	sig := r.signer.sign(t, m.Action, body)
	const n = 8
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			_, err := r.v.Handle(context.Background(), m.Action, body, sig, t0)
			errs <- err
		}()
	}
	ok := 0
	for i := 0; i < n; i++ {
		if err := <-errs; err == nil {
			ok++
		} else {
			assert.ErrorIs(t, err, devicekey.ErrNonceRepeat)
		}
	}
	assert.Equal(t, 1, ok)
}

// Security's SHOULD 3: a nonce lives for the window plus twice the skew, and is dropped only once strictly past that.
func TestNonceKeptForWindowPlusTwiceTheSkewEdge(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	m := r.raise(r.signer, target.kid, "interact") // short window: 5 min
	_, err := r.handle(m, r.signer, t0)
	require.NoError(t, err)
	keep := 5*time.Minute + 2*5*time.Minute
	assert.ErrorIs(t, r.ss.RecordNonce(context.Background(), m.Nonce, r.signer.kid, t0.Add(keep), 5*time.Minute), store.ErrNonceRepeat, "still kept at exactly the end")
	assert.NoError(t, r.ss.RecordNonce(context.Background(), m.Nonce, r.signer.kid, t0.Add(keep+time.Second), 5*time.Minute), "gone one second later")
}

// Second MUST on slice 3 (Security + QA): who may remove whom.
func TestRemoveDeviceAuthority(t *testing.T) {
	r := newRig(t)
	mk := func(mode, origin string) signer {
		s := newSigner(t)
		r.add(s, mode, origin, store.DeviceKindDevice)
		return s
	}
	boot, np := mk("interact", store.DeviceOriginBootstrap), mk("interact", store.DeviceOriginNoProof)
	view := mk("view", store.DeviceOriginPairing)
	inter := mk("interact", store.DeviceOriginPairing)
	victim := mk("view", store.DeviceOriginPairing)

	r.refused(devicekey.ErrSignerBootstrap, r.remove(boot, victim.kid), boot, t0)
	r.refused(devicekey.ErrSignerNoProof, r.remove(np, victim.kid), np, t0)
	r.refused(devicekey.ErrAboveSigner, r.remove(view, inter.kid), view, t0)
	_, ok := r.listed(inter.kid)
	assert.True(t, ok)
	// allowed: a bootstrap or no-proof device removes itself, a pairing device removes one at or below its mode
	_, err := r.handle(r.remove(boot, boot.kid), boot, t0)
	assert.NoError(t, err)
	_, err = r.handle(r.remove(np, np.kid), np, t0)
	assert.NoError(t, err)
	_, err = r.handle(r.remove(view, victim.kid), view, t0)
	assert.NoError(t, err, "same mode")
	_, err = r.handle(r.remove(r.signer, inter.kid), r.signer, t0)
	assert.NoError(t, err, "a launch pairing device removes a lower one")
}

func TestApproveOfAListedKidIsRefused(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	m := r.approve(r.signer, target, "interact")
	r.refused(devicekey.ErrBadForm, m, r.signer, t0)
	k, _ := r.listed(target.kid)
	assert.Equal(t, "view", k.Mode)
}

// Ruling (a): removing a launch-mode device needs a pairing-origin launch-mode signer.
func TestRemovingALaunchDeviceNeedsALaunchPairingSigner(t *testing.T) {
	r := newRig(t)
	inter, launch := newSigner(t), newSigner(t)
	r.add(inter, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.add(launch, "launch", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrAboveSigner, r.remove(inter, launch.kid), inter, t0)
	_, err := r.handle(r.remove(r.signer, launch.kid), r.signer, t0)
	assert.NoError(t, err)
}

// Ruling (c): a removal is never refused for the list ceiling.
func TestRemovalIsNeverRefusedForTheCeiling(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	victim := newSigner(t)
	r.add(victim, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	full := false
	for i := 0; i < 1000 && !full; i++ {
		s := newSigner(t)
		raw, _ := b64.DecodeString(s.pk)
		if _, err := r.ss.AddDeviceKey(ctx, store.DeviceKey{KID: s.kid, PK: raw, Label: "d", Mode: "view", Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice}, t0); err != nil {
			require.ErrorIs(t, err, store.ErrKeyLimit)
			full = true
			break
		}
		require.NoError(t, r.ss.RemoveDeviceKey(ctx, s.kid, store.DeviceRemoved, t0))
	}
	require.True(t, full, "the removed list reached its ceiling")
	_, err := r.handle(r.remove(r.signer, victim.kid), r.signer, t0)
	assert.NoError(t, err)
}

// Ruling (d): every removal is audited with the signer's kid.
func TestRemovalIsAuditedWithTheSignersKid(t *testing.T) {
	r := newRig(t)
	victim := newSigner(t)
	r.add(victim, "view", store.DeviceOriginPairing, store.DeviceKindDevice)
	var got []string
	r.v.Audit = func(a devicekey.Action, signerKID, targetKID, targetMode string) {
		got = append(got, string(a)+" "+signerKID+" "+targetKID+" "+targetMode)
	}
	_, err := r.handle(r.remove(r.signer, victim.kid), r.signer, t0)
	require.NoError(t, err)
	assert.Equal(t, []string{"remove-device " + r.signer.kid + " " + victim.kid + " view"}, got, "with the kid and the mode the removed device had")
	r.refused(devicekey.ErrUnknownTarget, r.remove(r.signer, victim.kid), r.signer, t0)
	assert.Len(t, got, 1, "a refused removal is not audited as a removal")
}

// Ruling (f): bad_mode and unknown_target come only after the signature and the nonce-repeat check, so a replay is nonce_repeat and the refusal says nothing about the list.
func TestBadModeAndUnknownTargetComeAfterTheNonceCheck(t *testing.T) {
	r := newRig(t)
	m := r.raise(r.signer, "A"+newSigner(t).kid[1:], "interact") // unknown target
	require.NoError(t, r.ss.RecordNonce(context.Background(), m.Nonce, r.signer.kid, t0, 5*time.Minute))
	_, err := r.handle(m, r.signer, t0)
	assert.ErrorIs(t, err, devicekey.ErrNonceRepeat)
	b := r.raise(r.signer, r.signer.kid, "nonsense") // bad mode
	require.NoError(t, r.ss.RecordNonce(context.Background(), b.Nonce, r.signer.kid, t0, 5*time.Minute))
	_, err = r.handle(b, r.signer, t0)
	assert.ErrorIs(t, err, devicekey.ErrNonceRepeat)
	// a forged signature still never gets that far
	body, _ := m.Canonical()
	_, err = r.v.Handle(context.Background(), m.Action, body, "x", t0)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
}

// coral-hub Security (#19690): a raise looks at the target's current mode too, and never lowers.
func TestRaiseRefusesATargetAboveTheSigner(t *testing.T) {
	r := newRig(t)
	inter, launch := newSigner(t), newSigner(t)
	r.add(inter, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.add(launch, "launch", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrAboveSigner, r.raise(inter, launch.kid, "interact"), inter, t0)
	k, _ := r.listed(launch.kid)
	assert.Equal(t, "launch", k.Mode, "a lowering by an interact signer did not happen")
}

func TestRaiseMustBeStrictlyAboveTheTargetsCurrentMode(t *testing.T) {
	r := newRig(t)
	target := newSigner(t)
	r.add(target, "interact", store.DeviceOriginPairing, store.DeviceKindDevice)
	r.refused(devicekey.ErrBadMode, r.raise(r.signer, target.kid, "interact"), r.signer, t0) // same
	r.refused(devicekey.ErrBadMode, r.raise(r.signer, target.kid, "view"), r.signer, t0)     // lower
	_, err := r.handle(r.raise(r.signer, target.kid, "launch"), r.signer, t0)
	assert.Error(t, err) // launch is the top mode: refused as top_mode, never set by a message
	assert.ErrorIs(t, err, devicekey.ErrTopMode)
}

func TestRaiseOfABootstrapTargetSaysTargetBootstrap(t *testing.T) {
	r := newRig(t)
	boot := newSigner(t)
	r.add(boot, "view", store.DeviceOriginBootstrap, store.DeviceKindDevice)
	r.refused(devicekey.ErrTargetBootstrap, r.raise(r.signer, boot.kid, "interact"), r.signer, t0)
}

// Condition (d): the audit line for a removal names the kids and the mode, and nothing from the message beyond them.
func TestAuditLineNamesTheKidsAndTheMode(t *testing.T) {
	var b strings.Builder
	lg := slog.New(slog.NewTextHandler(&b, nil))
	devicekey.AuditLine(lg)(devicekey.RemoveDevice, "SIGNER", "TARGET", "interact")
	assert.Contains(t, b.String(), "device removed")
	assert.Contains(t, b.String(), "signer=SIGNER")
	assert.Contains(t, b.String(), "kid=TARGET")
	assert.Contains(t, b.String(), "mode=interact")
}
