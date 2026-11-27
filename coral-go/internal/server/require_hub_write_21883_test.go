package server

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21883 commit 2: with the switch on, a write that is no named kind's route is the generic kind hub-write: signed by a trusted key whose mode reaches the route's tier, or refused.
func TestWithTheSwitchOnAnyOtherWriteIsSignedAsHubWrite(t *testing.T) {
	g := newRelayRig(t)
	ctx := context.Background()
	const target = "/api/saved/x1" // an interact-tier write no named kind lists
	hw := relayReq{kind: devicekey.HubWrite, method: "DELETE", target: target, priv: g.bound, kid: g.bndK}

	// Off: nothing about it changes; an unsigned one reaches its handler and a signature on it is not read.
	unsigned := func() string {
		h := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: relayPerson, "Content-Type": "application/json"}
		return relayCode(call(g.d.r.srv.Router(), "DELETE", target, "", h))
	}
	assert.Empty(t, unsigned(), "off: unsigned reaches the handler")

	require.NoError(t, store.NewSessionStore(g.d.r.db).SetSetting(ctx, routes.HubRequireTrustedDeviceSetting, "true"))

	assert.Equal(t, "device_required", unsigned(), "on: unsigned is refused")
	assert.Empty(t, relayCode(g.signed(hw)), "on: a trusted key signs it as hub-write")

	wrongKind := hw
	wrongKind.kind = devicekey.SendToAgent
	assert.Equal(t, "bad_signature", relayCode(g.signed(wrongKind)), "the kind is the route's and is in the signed input: another kind's signature does not verify")

	named := relayReq{kind: devicekey.HubWrite, method: "POST", target: "/api/sessions/live/agent1/send", body: `{"text":"hi"}`, priv: g.bound, kid: g.bndK}
	assert.Equal(t, "bad_signature", relayCode(g.signed(named)), "hub-write does not stand in for a named kind on that kind's own route")

	// A view key cannot sign a write above view.
	_, err := g.d.r.db.ExecContext(ctx, `UPDATE device_keys SET mode = 'view' WHERE kid = ?`, g.bndK)
	require.NoError(t, err)
	assert.Equal(t, "above_signer", relayCode(g.signed(hw)), "the key's mode is below the route's tier")
	assert.Equal(t, tunnel.TierInteract, devicekey.HubWriteNeed("DELETE", target))
}

// The local off-ramp spends no nonce: with the nonce store full (so every signed Hub action is refused) the person at this computer can still turn the switch off.
func TestTheOffRampWorksWithAFullNonceStore(t *testing.T) {
	g := newRelayRig(t)
	ctx := context.Background()
	ss := store.NewSessionStore(g.d.r.db)
	require.NoError(t, ss.SetSetting(ctx, routes.HubRequireTrustedDeviceSetting, "true"))
	tx, err := g.d.r.db.BeginTx(ctx, nil)
	require.NoError(t, err)
	exp := time.Now().Add(10 * time.Minute).Unix()
	for i := 0; i < 50000; i++ {
		_, err = tx.ExecContext(ctx, `INSERT INTO device_nonces (nonce, kid, accepted_at, expires_at) VALUES (?, ?, ?, ?)`, fmt.Sprintf("fill-%d", i), fmt.Sprintf("kid-%d", i%15), time.Now().Unix(), exp)
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit())

	send := relayReq{kind: devicekey.SendToAgent, method: "POST", target: "/api/sessions/live/agent1/send", body: `{"text":"hi"}`, priv: g.bound, kid: g.bndK}
	assert.Equal(t, "nonce_store_full", relayCode(g.signed(send)), "a full store refuses every signed Hub action")

	rec := call(g.d.r.srv.Router(), "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, map[string]string{"Content-Type": "application/json"})
	assert.Equal(t, 200, rec.Code, rec.Body.String())
	assert.False(t, routes.HubRequireTrustedDevice(mustSettings(t, ss)), "the switch is off again")
}

func mustSettings(t *testing.T, ss *store.SessionStore) map[string]string {
	t.Helper()
	m, err := ss.GetSettings(context.Background())
	require.NoError(t, err)
	return m
}
