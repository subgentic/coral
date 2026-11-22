package routes

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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

	require.NoError(t, ss.SetDeviceMode(ctx, fresh.KID, "interact", t0))
	items, _ = DeviceKeyNoticeItems(ss, func() time.Time { return t0 })(ctx)
	require.Len(t, items, 1)
	assert.Contains(t, items[0].Line, "raised")
	assert.Contains(t, items[0].Line, "interact")
}
