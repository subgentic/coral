package store_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

func ocStore(t *testing.T) *store.SessionStore {
	t.Helper()
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	return store.NewSessionStore(db)
}

func ocPK(t *testing.T) []byte {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return k.PublicKey().Bytes()
}

func TestOwnerAnchorIsOneAndReplacedOnlyOnPurposeAndReplacingDropsKeeps(t *testing.T) {
	ss, ctx, t0 := ocStore(t), context.Background(), time.Unix(1_800_000_000, 0)
	a, b := ocPK(t), ocPK(t)
	ok, err := ss.SetOwnerAnchor(ctx, a, "cred-a", false, t0)
	require.NoError(t, err)
	assert.True(t, ok)
	ok, err = ss.SetOwnerAnchor(ctx, b, "cred-b", false, t0)
	require.NoError(t, err)
	assert.False(t, ok, "a second anchor is not listed unless the person chose Replace")
	row, has, _ := ss.OwnerAnchorRow(ctx)
	require.True(t, has)
	assert.Equal(t, store.AnchorKID(a), row.KID)

	_, _, err = ss.SeenCertifiedDevice(ctx, "dev1", store.AnchorKID(a), "Laptop", t0)
	require.NoError(t, err)
	require.NoError(t, ss.KeepCertifiedDevice(ctx, "dev1", "interact", t0))
	ok, err = ss.SetOwnerAnchor(ctx, b, "cred-b", true, t0)
	require.NoError(t, err)
	assert.True(t, ok)
	d, _, _ := ss.CertifiedDeviceRow(ctx, "dev1")
	assert.Empty(t, d.KeptMode, "replacing the anchor drops every Keep")
	_, err = ss.SetOwnerAnchor(ctx, []byte("short"), "c", true, t0)
	assert.ErrorIs(t, err, store.ErrAnchorForm)
}

func TestOwnerEpochNeverGoesDownAndRisesByAtMostTheStep(t *testing.T) {
	ss, ctx, t0 := ocStore(t), context.Background(), time.Unix(1_800_000_000, 0)
	require.NoError(t, ss.RaiseOwnerEpoch(ctx, "o", 5, t0))
	e, _ := ss.OwnerEpoch(ctx, "o")
	assert.EqualValues(t, 5, e)
	assert.ErrorIs(t, ss.RaiseOwnerEpoch(ctx, "o", 4, t0), store.ErrEpochLower)
	assert.NoError(t, ss.RaiseOwnerEpoch(ctx, "o", 5, t0))
	assert.ErrorIs(t, ss.RaiseOwnerEpoch(ctx, "o", 5+store.EpochStepCap+1, t0), store.ErrEpochJump)
	require.NoError(t, ss.RaiseOwnerEpoch(ctx, "o", 5+store.EpochStepCap, t0))
	e, _ = ss.OwnerEpoch(ctx, "o")
	assert.EqualValues(t, 5+store.EpochStepCap, e)
}

func TestACertifiedDeviceStartsUnkeptAndADenyOutlivesKeepAndAnchor(t *testing.T) {
	ss, ctx, t0 := ocStore(t), context.Background(), time.Unix(1_800_000_000, 0)
	d, first, err := ss.SeenCertifiedDevice(ctx, "dev1", "owner", "Laptop", t0)
	require.NoError(t, err)
	assert.True(t, first)
	assert.Empty(t, d.KeptMode, "stays at view until Keep")
	_, first, _ = ss.SeenCertifiedDevice(ctx, "dev1", "owner", "Other label", t0.Add(time.Minute))
	assert.False(t, first)
	d, _, _ = ss.CertifiedDeviceRow(ctx, "dev1")
	assert.Equal(t, "Laptop", d.Label, "the first label stays")
	require.NoError(t, ss.KeepCertifiedDevice(ctx, "dev1", "launch", t0))
	require.NoError(t, ss.DenyCertifiedDevice(ctx, "dev1", "Laptop", t0))
	d, _, _ = ss.CertifiedDeviceRow(ctx, "dev1")
	assert.NotZero(t, d.DeniedAt)
	assert.Empty(t, d.KeptMode)
	assert.ErrorIs(t, ss.KeepCertifiedDevice(ctx, "dev1", "view", t0), store.ErrUnknownCertified, "a Keep never un-denies")
	require.NoError(t, ss.RemoveOwnerAnchor(ctx))
	d, _, _ = ss.CertifiedDeviceRow(ctx, "dev1")
	assert.NotZero(t, d.DeniedAt, "the deny row outlives the anchor")
	require.NoError(t, ss.DenyCertifiedDevice(ctx, "never-seen", "x", t0))
	n, _ := ss.ListCertifiedDevices(ctx)
	assert.Len(t, n, 2)
}

func TestANewEnrollmentClearsAnchorEpochAndCertifiedDevices(t *testing.T) {
	ss, ctx, t0 := ocStore(t), context.Background(), time.Unix(1_800_000_000, 0)
	pk := ocPK(t)
	_, err := ss.SetOwnerAnchor(ctx, pk, "c", false, t0)
	require.NoError(t, err)
	require.NoError(t, ss.RaiseOwnerEpoch(ctx, store.AnchorKID(pk), 3, t0))
	require.NoError(t, ss.DenyCertifiedDevice(ctx, "dev1", "x", t0))
	_, err = ss.RemoveAllDeviceKeys(ctx, t0)
	require.NoError(t, err)
	_, has, _ := ss.OwnerAnchorRow(ctx)
	assert.False(t, has)
	e, _ := ss.OwnerEpoch(ctx, store.AnchorKID(pk))
	assert.Zero(t, e)
	l, _ := ss.ListCertifiedDevices(ctx)
	assert.Empty(t, l)
}

func TestTheCertifiedDeviceTableIsBounded(t *testing.T) {
	ss, ctx, t0 := ocStore(t), context.Background(), time.Unix(1_800_000_000, 0)
	for i := 0; i < store.CertifiedCap; i++ {
		_, _, err := ss.SeenCertifiedDevice(ctx, "d"+string(rune('a'+i%26))+time.Duration(i).String(), "o", "x", t0)
		require.NoError(t, err)
	}
	_, _, err := ss.SeenCertifiedDevice(ctx, "one-more", "o", "x", t0)
	assert.ErrorIs(t, err, store.ErrCertifiedLimit)
}
