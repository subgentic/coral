package devicekey_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// #20649, Hub Security's MUSTs (#262424): what a grant-member and a hub-auto-accept request add to the relayed signature.

const gmActor = "hub-user-0a1b2c3d"

func gmPin(string) (string, bool) { return gmActor, true }

func gmMsg(r *rig, k devicekey.Kind, s signer, method, path string, body []byte) devicekey.Relayed {
	m := r.relayedMsg(k, s, body)
	m.Method, m.Path = method, path
	return m
}

// the body's signature kid is the relayed signer's, whoever else's key is named
func gmGrantBody(kid string) []byte {
	return []byte(`{"link_id":"lnk_1","hub_user":"hub-user-99999999","level":"view","signature":{"kid":"` + kid + `","nonce":"n","ts":1,"sig":"s"}}`)
}

func TestTheGrantMemberRowIsBodyCoveredByTheRelayedSignature(t *testing.T) {
	r := newRig(t)
	body := gmGrantBody(r.signer.kid)
	m := gmMsg(r, devicekey.GrantMember, r.signer, "POST", "/api/member-grants", body)
	c, err := m.Canonical()
	require.NoError(t, err)
	sig := r.signer.signRelayed(t, m.Kind, c)
	ok := func(b []byte) error {
		_, err := r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/member-grants", m.Kind, c, b, sig, t0, devicekey.GrantMemberAuthorizer(gmActor, gmPin, b))
		return err
	}
	// one level or one grantee swapped after signing is a different body: body_hash, and nothing is spent
	swapped := []byte(`{"link_id":"lnk_1","hub_user":"hub-user-99999999","level":"full","signature":{"kid":"` + r.signer.kid + `","nonce":"n","ts":1,"sig":"s"}}`)
	assert.ErrorIs(t, ok(swapped), devicekey.ErrBodyHash, "the level changed after signing")
	assert.ErrorIs(t, ok(nil), devicekey.ErrBodyHash, "the body dropped")
	assert.NoError(t, ok(body), "the exact body, and the refusals spent nothing")
	assert.Contains(t, string(devicekey.RelayedSigningInput(m.Kind, c)), devicekey.BodySHA256(body), "the signed text carries the body's hash")
}

func TestAGranteeKeyNeverSignsAGrantOrTheAutoAcceptToggle(t *testing.T) {
	r := newRig(t)
	grantee := newSigner(t)
	r.addPaired(grantee, "launch", "lnk_1", gmActor)
	cases := []struct {
		kind         devicekey.Kind
		method, path string
		body         []byte
	}{
		{devicekey.GrantMember, "POST", "/api/member-grants", gmGrantBody(grantee.kid)},
		{devicekey.GrantMember, "DELETE", "/api/member-grants/g1", nil},
		{devicekey.HubAutoAccept, "POST", "/api/hub-auto-accept?allow=true", nil},
	}
	for _, c := range cases {
		auth := devicekey.GrantMemberAuthorizer(gmActor, gmPin, c.body)
		signer, ok := r.listed(grantee.kid)
		require.True(t, ok)
		m := gmMsg(r, c.kind, grantee, c.method, c.path, c.body)
		assert.ErrorIs(t, auth(m, signer), devicekey.ErrOutsidePair, string(c.kind)+" "+c.method+": a grantee's key")
		ownerKey, ok := r.listed(r.signer.kid)
		require.True(t, ok)
		m = gmMsg(r, c.kind, r.signer, c.method, c.path, c.body)
		if c.kind == devicekey.GrantMember && c.method == "POST" {
			m = gmMsg(r, c.kind, r.signer, c.method, c.path, gmGrantBody(r.signer.kid))
			auth = devicekey.GrantMemberAuthorizer(gmActor, gmPin, gmGrantBody(r.signer.kid))
		}
		assert.NoError(t, auth(m, ownerKey), string(c.kind)+" "+c.method+": the owner's key")
	}
}

func TestTheOwnersKeyThatSignedTheRequestIsTheOneNamedInTheGrant(t *testing.T) {
	r := newRig(t)
	other := newSigner(t)
	r.add(other, "launch", store.DeviceOriginPairing, store.DeviceKindDevice) // another owner device
	signerRow, _ := r.listed(r.signer.kid)
	body := gmGrantBody(other.kid) // the grant's signature is another key's
	m := gmMsg(r, devicekey.GrantMember, r.signer, "POST", "/api/member-grants", body)
	assert.ErrorIs(t, devicekey.GrantMemberAuthorizer(gmActor, gmPin, body)(m, signerRow), devicekey.ErrOutsidePair)
	for _, bad := range []string{``, `not json`, `{}`, `{"signature":{}}`, `{"signature":{"kid":""}}`} {
		assert.ErrorIs(t, devicekey.GrantMemberAuthorizer(gmActor, gmPin, []byte(bad))(m, signerRow), devicekey.ErrOutsidePair, bad)
	}
}

func TestTheAutoAcceptValueIsInTheSignedQueryAndABodyCannotDisagree(t *testing.T) {
	r := newRig(t)
	owner, _ := r.listed(r.signer.kid)
	run := func(path string, body []byte) error {
		m := gmMsg(r, devicekey.HubAutoAccept, r.signer, "POST", path, body)
		return devicekey.GrantMemberAuthorizer(gmActor, gmPin, body)(m, owner)
	}
	assert.NoError(t, run("/api/hub-auto-accept?allow=true", nil))
	assert.NoError(t, run("/api/hub-auto-accept?allow=false", []byte(`{"allow":false}`)), "a body that says the same")
	for _, p := range []string{"/api/hub-auto-accept", "/api/hub-auto-accept?", "/api/hub-auto-accept?allow=1", "/api/hub-auto-accept?allow=true&x=1", "/api/hub-auto-accept?allow=true&allow=false", "/api/hub-auto-accept?x=1&allow=true", "/api/hub-auto-accept?allow=TRUE"} {
		assert.ErrorIs(t, run(p, nil), devicekey.ErrWrongRequest, p)
	}
	assert.ErrorIs(t, run("/api/hub-auto-accept?allow=true", []byte(`{"allow":false}`)), devicekey.ErrWrongRequest, "the body disagrees with the query: refused, not merged")
	assert.ErrorIs(t, run("/api/hub-auto-accept?allow=true", []byte(`{}`)), devicekey.ErrWrongRequest, "a body that names no value")
	assert.ErrorIs(t, run("/api/hub-auto-accept?allow=true", []byte(`junk`)), devicekey.ErrWrongRequest)
	// the route table agrees: no other query is a route of the kind
	_, ok := devicekey.MatchRoute(devicekey.HubAutoAccept, "POST", "/api/hub-auto-accept")
	assert.False(t, ok)
	_, ok = devicekey.MatchRoute(devicekey.HubAutoAccept, "POST", "/api/hub-auto-accept?allow=false")
	assert.True(t, ok)
	v, ok := devicekey.AutoAcceptQuery("/api/hub-auto-accept?allow=false")
	assert.True(t, ok)
	assert.False(t, v)
}

func TestEveryOwnerOnlyKindIsNamedAndNoOtherKindIs(t *testing.T) {
	var got []devicekey.Kind
	for _, k := range devicekey.RelayedKinds {
		if devicekey.OwnerOnly(k) {
			got = append(got, k)
		}
	}
	assert.ElementsMatch(t, []devicekey.Kind{devicekey.GrantMember, devicekey.HubAutoAccept}, got)
}

func TestTheGrantSignatureNeedsAnOwnerDeviceAndBindsThisComputer(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	digest := []byte("coral/member-grant/1\nlnk_1\nhub-user-99999999\nview")
	signGrant := func(s signer, computer string, d []byte) string {
		return s.signRaw(t, devicekey.GrantSigningInput(computer, d))
	}

	mode, err := r.v.VerifyOwnerGrant(ctx, digest, r.signer.kid, signGrant(r.signer, r.computer, digest), t0)
	require.NoError(t, err)
	assert.Equal(t, "launch", mode, "the mode is the computer's own record")

	_, err = r.v.VerifyOwnerGrant(ctx, digest, r.signer.kid, signGrant(r.signer, "another-computer-fingerprint", digest), t0)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature, "a signature made for another computer")
	_, err = r.v.VerifyOwnerGrant(ctx, append([]byte{}, append(digest, 'x')...), r.signer.kid, signGrant(r.signer, r.computer, digest), t0)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature, "a digest recomputed from another body")
	grantee := newSigner(t)
	r.addPaired(grantee, "launch", "lnk_1", gmActor)
	_, err = r.v.VerifyOwnerGrant(ctx, digest, grantee.kid, signGrant(grantee, r.computer, digest), t0)
	assert.ErrorIs(t, err, devicekey.ErrOutsidePair, "a grantee's key, even with a good signature")
	_, err = r.v.VerifyOwnerGrant(ctx, digest, newSigner(t).kid, "x", t0)
	assert.Error(t, err, "an unknown key")
	// a step-2 style signature (v2 label) over the same bytes is not a grant
	_, err = r.v.VerifyOwnerGrant(ctx, digest, r.signer.kid, r.signer.sign(t, devicekey.RaiseMode, digest), t0)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
}

// signRaw signs bytes as they are (the grant's own signing input), P1363.
func (s signer) signRaw(t *testing.T, msg []byte) string {
	t.Helper()
	h := sha256.Sum256(msg)
	r, ss, err := ecdsa.Sign(rand.Reader, s.priv, h[:])
	require.NoError(t, err)
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	ss.FillBytes(sig[32:])
	return b64.EncodeToString(sig)
}
