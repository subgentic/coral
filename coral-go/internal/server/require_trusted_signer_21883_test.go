package server

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
)

// #21883 round 2 (Security MUST 1): with the switch on, a signature counts only from a key whose origin is in store.TrustedDeviceOrigins. A key a broken-into Hub could have planted (bootstrap, no proof) is refused signer_no_proof, even though it verifies.
func TestWithTheSwitchOnOnlyAKeyOnTheTrustedOriginsSigns(t *testing.T) {
	g := newRelayRig(t)
	ctx := context.Background()
	mk := func(origin string) relayReq {
		priv, kid := g.addKey(testLinkID, relayPerson)
		_, err := g.d.r.db.ExecContext(ctx, `UPDATE device_keys SET origin = ? WHERE kid = ?`, origin, kid)
		require.NoError(t, err)
		return relayReq{kind: devicekey.SendToAgent, method: "POST", target: "/api/sessions/live/agent1/send", body: `{"text":"hi"}`, priv: priv, kid: kid}
	}
	pairing, bootstrap, noproof := mk(store.DeviceOriginPairing), mk(store.DeviceOriginBootstrap), mk(store.DeviceOriginNoProof)

	// Switch off: the origin is not asked (no behaviour change for a computer that never turns it on).
	assert.NotEqual(t, "signer_no_proof", relayCode(g.signed(bootstrap)), "off: origin is not checked")

	require.NoError(t, store.NewSessionStore(g.d.r.db).SetSetting(ctx, routes.HubRequireTrustedDeviceSetting, "true"))
	assert.Equal(t, "signer_no_proof", relayCode(g.signed(bootstrap)), "a bootstrap key is not a trusted signer")
	assert.Equal(t, "signer_no_proof", relayCode(g.signed(noproof)), "a no-proof key is not a trusted signer")
	assert.Empty(t, relayCode(g.signed(pairing)), "a key made with the pairing code signs")
}

func TestTheTrustedOriginsAreOneNamedList(t *testing.T) {
	assert.Equal(t, []string{store.DeviceOriginPairing}, store.TrustedDeviceOrigins)
	assert.True(t, store.IsTrustedDeviceOrigin(store.DeviceOriginPairing))
	assert.False(t, store.IsTrustedDeviceOrigin(store.DeviceOriginBootstrap))
	assert.False(t, store.IsTrustedDeviceOrigin(store.DeviceOriginNoProof))
	assert.False(t, store.IsTrustedDeviceOrigin(""))
}
