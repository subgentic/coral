package routes

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

func TestDeviceKeyNoticesShowANewKeyByItsFingerprintForADay(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	t0 := time.Unix(1_800_000_000, 0)
	mk := func(label, approvedBy string, at time.Time) store.DeviceKey {
		k, err := ecdh.P256().GenerateKey(rand.Reader)
		require.NoError(t, err)
		raw := k.PublicKey().Bytes()
		sum := sha256.Sum256(raw)
		dk := store.DeviceKey{KID: base64.RawURLEncoding.EncodeToString(sum[:]), PK: raw, Label: label, Mode: "view", Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner, ApprovedBy: approvedBy}
		_, err = ss.AddDeviceKey(ctx, dk, at)
		require.NoError(t, err)
		return dk
	}
	owner := mk("Owner laptop", "", t0.Add(-48*time.Hour))
	fresh := mk("Phone", owner.KID, t0.Add(-time.Hour))
	mk("Old approval", owner.KID, t0.Add(-30*time.Hour))
	items, err := DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	require.NoError(t, err)
	require.Len(t, items, 1, "only a key a message made, and only for a day: the owner's own key and the old approval are not here")
	assert.Equal(t, "device_key", items[0].Kind)
	assert.Contains(t, items[0].Line, devicekey.DisplayFingerprint(fresh.PK))
	assert.Contains(t, items[0].Line, "Owner laptop")
	assert.NotContains(t, items[0].Line, "Phone", "the new key's own label is the sender's word, not shown")

	// A raise names who raised it, not who approved the key: "Second laptop" raises "Phone", which "Owner laptop" approved.
	second := mk("Second laptop", "", t0.Add(-47*time.Hour))
	require.NoError(t, ss.SetDeviceMode(ctx, fresh.KID, "interact", second.KID, t0))
	items, _ = DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	require.Len(t, items, 1)
	assert.Contains(t, items[0].Line, "raised by \"Second laptop\"")
	assert.NotContains(t, items[0].Line, "Owner laptop", "not the original approver")
	assert.Contains(t, items[0].Line, "interact")

	// A key made at this computer (no approver) that a signed message raised is told too.
	require.NoError(t, ss.SetDeviceMode(ctx, owner.KID, "interact", fresh.KID, t0))
	items, _ = DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	require.Len(t, items, 2, "the owner-made key's raise is in the list")
	var lines []string
	for _, it := range items {
		lines = append(lines, it.Line)
	}
	assert.Contains(t, strings.Join(lines, "\n"), devicekey.DisplayFingerprint(owner.PK))
	assert.Contains(t, strings.Join(lines, "\n"), "raised by \"Phone\"")

	// A raise made at this computer, by the person here, is not news to them.
	require.NoError(t, ss.SetDeviceMode(ctx, second.KID, "launch", "", t0))
	items, _ = DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	assert.Len(t, items, 2)
}

// #21880: a browser the person allowed at this computer is told as "<label> can now act on this computer as <mode>", with its fingerprint, and a key whose mode the person raised here still is not.
func TestDeviceKeyNoticesTellABrowserAllowedThroughPairing(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	t0 := time.Unix(1_800_000_000, 0)
	mk := func() store.DeviceKey {
		k, err := ecdh.P256().GenerateKey(rand.Reader)
		require.NoError(t, err)
		raw := k.PublicKey().Bytes()
		sum := sha256.Sum256(raw)
		return store.DeviceKey{KID: base64.RawURLEncoding.EncodeToString(sum[:]), PK: raw, Label: "Phone", Mode: "view", Origin: store.DeviceOriginNoProof, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}
	}
	k := mk()
	_, err = ss.AddDeviceKey(ctx, k, t0.Add(-time.Hour))
	require.NoError(t, err)
	require.NoError(t, devicekey.AddPairedKey(ctx, ss, k.KID, k.PK, "Phone", "view", t0))
	local := mk()
	local.Label = "Mine"
	_, err = ss.AddDeviceKey(ctx, local, t0.Add(-time.Hour))
	require.NoError(t, err)
	require.NoError(t, ss.SetDeviceMode(ctx, local.KID, "interact", "", t0))
	items, err := DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	require.NoError(t, err)
	require.Len(t, items, 1, "the person's own raise here is not told, the allowed browser is")
	assert.Contains(t, items[0].Line, "\"Phone\" can now act on this computer as view")
	assert.Contains(t, items[0].Line, devicekey.DisplayFingerprint(k.PK))
}
