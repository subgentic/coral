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

// M1 and M2 of Security's device-signing read (#20514, task #20513): a device key belongs to the (link, Hub label) pair the computer set when it made the row, a signed message acts only inside its signer's pair, and
// the computer checks the link a message arrived on. A key with no pair is the owner's own (made at this computer) and is not held to one.

const (
	linkA = "lnk_a"
	linkB = "lnk_b"
	userA = "hub-user-aaaaaaaa"
	userB = "hub-user-bbbbbbbb"
)

func (r *rig) addPaired(s signer, mode, link, hubUser string) {
	r.t.Helper()
	raw, _ := b64.DecodeString(s.pk)
	_, err := r.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: s.kid, PK: raw, Label: "dev", Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: link, HubUser: hubUser}, t0.Add(-time.Hour))
	require.NoError(r.t, err)
}

func (r *rig) handleOn(link string, m devicekey.Message, s signer) error {
	r.t.Helper()
	body, err := m.Canonical()
	require.NoError(r.t, err)
	_, err = r.v.HandleOn(context.Background(), link, m.Action, body, s.sign(r.t, m.Action, body), t0)
	return err
}

func (r *rig) pairOf(kid string) (string, string) {
	k, ok := r.listed(kid)
	require.True(r.t, ok)
	return k.Link, k.HubUser
}

func TestThePairIsStoredWithTheKey(t *testing.T) {
	r := newRig(t)
	s := newSigner(t)
	r.addPaired(s, "view", linkA, userA)
	l, u := r.pairOf(s.kid)
	assert.Equal(t, [2]string{linkA, userA}, [2]string{l, u})
	l, u = r.pairOf(r.signer.kid)
	assert.Equal(t, [2]string{"", ""}, [2]string{l, u}, "a key made at the computer has no pair")
}

func TestAKeyApprovedInsideAPairBelongsToThatPair(t *testing.T) {
	r := newRig(t)
	a := newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	target := newSigner(t)
	require.NoError(t, r.handleOn(linkA, r.approve(a, target, "view"), a))
	l, u := r.pairOf(target.kid)
	assert.Equal(t, [2]string{linkA, userA}, [2]string{l, u}, "the pair is the signer's, set by the computer, never by the message")
}

func TestAPasskeyTrustedInsideAPairBelongsToThatPair(t *testing.T) {
	r := newRig(t)
	a := newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	f := fixture(t)
	m := r.msg(devicekey.TrustPasskey, a)
	m.PasskeyPK, m.Label = f.passkeyPK, "Phone"
	require.NoError(t, r.handleOn(linkA, m, a))
	l, u := r.pairOf(kidOf(f.passkeyPK))
	assert.Equal(t, [2]string{linkA, userA}, [2]string{l, u})
}

func TestRaiseAndRemoveActOnlyInsideTheSignersPair(t *testing.T) {
	r := newRig(t)
	a, other, mine := newSigner(t), newSigner(t), newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	r.addPaired(other, "view", linkB, userB)
	r.addPaired(mine, "view", linkA, userA)
	assert.ErrorIs(t, r.handleOn(linkA, r.raise(a, other.kid, "interact"), a), devicekey.ErrOutsidePair)
	assert.ErrorIs(t, r.handleOn(linkA, r.remove(a, other.kid), a), devicekey.ErrOutsidePair)
	_, ok := r.listed(other.kid)
	assert.True(t, ok, "the other pair's key is untouched")
	require.NoError(t, r.handleOn(linkA, r.raise(a, mine.kid, "interact"), a))
	require.NoError(t, r.handleOn(linkA, r.remove(a, mine.kid), a))
}

func TestSameLinkOtherHubLabelIsAnotherPair(t *testing.T) {
	r := newRig(t)
	a, other := newSigner(t), newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	r.addPaired(other, "view", linkA, userB)
	assert.ErrorIs(t, r.handleOn(linkA, r.remove(a, other.kid), a), devicekey.ErrOutsidePair)
}

func TestTheOwnersKeyActsOnAnyPair(t *testing.T) {
	r := newRig(t)
	other := newSigner(t)
	r.addPaired(other, "view", linkB, userB)
	require.NoError(t, r.handleOn("", r.raise(r.signer, other.kid, "interact"), r.signer))
	require.NoError(t, r.handleOn(linkA, r.remove(r.signer, other.kid), r.signer), "from any link: the owner's key has no link")
}

func TestAPairedKeyIsRefusedOnAnyOtherLinkOrNone(t *testing.T) {
	r := newRig(t)
	a, target := newSigner(t), newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	assert.ErrorIs(t, r.handleOn(linkB, r.approve(a, target, "view"), a), devicekey.ErrWrongLink)
	assert.ErrorIs(t, r.handleOn("", r.approve(a, target, "view"), a), devicekey.ErrWrongLink, "no link is not the link")
	_, ok := r.listed(target.kid)
	assert.False(t, ok)
	require.NoError(t, r.handleOn(linkA, r.approve(a, target, "view"), a))
}

func TestHandleWithoutALinkIsTheOwnersPathOnly(t *testing.T) {
	r := newRig(t)
	a, target := newSigner(t), newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	_, err := r.handle(r.approve(a, target, "view"), a, t0)
	assert.ErrorIs(t, err, devicekey.ErrWrongLink)
}

// ---- v3: the link and Hub label in the message are the signer's pair, and the link is the one it arrived on ----

func TestRelayedMustCarryTheLinkItArrivedOnAndTheSignersPair(t *testing.T) {
	r := newRig(t)
	a := newSigner(t)
	r.addPaired(a, "interact", linkA, userA)
	body := []byte("b")
	mk := func(link, user string) devicekey.Relayed {
		m := r.relayedMsg(devicekey.SendToAgent, a, body)
		m.Link, m.HubUser = link, user
		return m
	}
	handle := func(arrived string, m devicekey.Relayed) error {
		c, err := m.Canonical()
		require.NoError(t, err)
		_, err = r.v.HandleRelayedOn(context.Background(), arrived, "POST", "/api/x", m.Kind, c, body, a.signRelayed(t, m.Kind, c), t0, allow)
		return err
	}
	assert.ErrorIs(t, handle(linkB, mk(linkA, userA)), devicekey.ErrWrongLink, "arrived on another link than the message names")
	assert.ErrorIs(t, handle(linkB, mk(linkB, userA)), devicekey.ErrWrongLink, "the message names a link that is not the signer's")
	assert.ErrorIs(t, handle(linkA, mk(linkA, userB)), devicekey.ErrOutsidePair, "another person's Hub label")
	assert.NoError(t, handle(linkA, mk(linkA, userA)))
}

func TestRelayedFromTheOwnersKeyStillNamesTheLinkItArrivedOn(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	m := r.relayedMsg(devicekey.BoardPost, r.signer, body) // Link lnk_1
	c, _ := m.Canonical()
	_, err := r.v.HandleRelayedOn(context.Background(), "lnk_2", "POST", "/api/x", m.Kind, c, body, r.signer.signRelayed(t, m.Kind, c), t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrWrongLink)
	_, err = r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", m.Kind, c, body, r.signer.signRelayed(t, m.Kind, c), t0, allow)
	assert.NoError(t, err)
}
