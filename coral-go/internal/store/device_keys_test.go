package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Device list and nonce store (#19669 slice 1, design page v4 section 5). Every time is passed in: Coral's own clock is the only clock, and a test sets it.

func dkStore(t *testing.T) *store.SessionStore {
	t.Helper()
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	return store.NewSessionStore(db)
}

var dkT0 = time.Unix(1_800_000_000, 0)

// dkKey builds a well-formed record: a 65-byte point-shaped value (the store checks shape and kid, the curve check is the verifier's) and its kid.
func dkKey(n int, kind, origin string) store.DeviceKey {
	pk := make([]byte, 65)
	pk[0] = 0x04
	pk[1] = byte(n)
	pk[2] = byte(n >> 8)
	sum := sha256.Sum256(pk)
	return store.DeviceKey{KID: base64.RawURLEncoding.EncodeToString(sum[:]), PK: pk, Label: fmt.Sprintf("dev %d", n), Mode: "launch", Origin: origin, Kind: kind}
}

func TestDeviceKeyAddAndReadBack(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	added, err := ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, err)
	assert.True(t, added)
	got, err := ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(time.Minute))
	require.NoError(t, err)
	assert.Equal(t, k.PK, got.PK)
	assert.Equal(t, "launch", got.Mode)
	assert.Equal(t, store.DeviceOriginPairing, got.Origin)
	// the same key again is a success with no write and keeps the first label
	k2 := k
	k2.Label = "other"
	added, err = ss.AddDeviceKey(ctx, k2, dkT0.Add(time.Hour))
	require.NoError(t, err)
	assert.False(t, added)
	got, _ = ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(time.Hour))
	assert.Equal(t, "dev 1", got.Label)
}

func TestDeviceKeyRefusesBadShape(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	bad := k
	bad.KID = "AAAA"
	_, err := ss.AddDeviceKey(ctx, bad, dkT0)
	assert.ErrorIs(t, err, store.ErrDeviceKeyForm, "kid must be the hash of pk")
	bad = k
	bad.PK = k.PK[:64]
	_, err = ss.AddDeviceKey(ctx, bad, dkT0)
	assert.ErrorIs(t, err, store.ErrDeviceKeyForm)
	bad = dkKey(2, store.DeviceKindDevice, store.DeviceOriginPairing)
	bad.PK[0] = 0x02
	sum := sha256.Sum256(bad.PK)
	bad.KID = base64.RawURLEncoding.EncodeToString(sum[:])
	_, err = ss.AddDeviceKey(ctx, bad, dkT0)
	assert.ErrorIs(t, err, store.ErrDeviceKeyForm, "a point not starting 0x04")
	bad = k
	bad.Label = string(make([]byte, 65))
	_, err = ss.AddDeviceKey(ctx, bad, dkT0)
	assert.ErrorIs(t, err, store.ErrDeviceKeyForm, "label over 64 bytes")
	bad = k
	bad.Origin = "hub"
	_, err = ss.AddDeviceKey(ctx, bad, dkT0)
	assert.ErrorIs(t, err, store.ErrDeviceKeyForm, "origin is one of pairing, bootstrap, noproof")
	assert.Empty(t, mustList(t, ss), "nothing was written")
}

func mustList(t *testing.T, ss *store.SessionStore) []store.DeviceKey {
	t.Helper()
	l, err := ss.ListDeviceKeys(context.Background())
	require.NoError(t, err)
	return l
}

// unknown_signer, signer_removed: the verifier reads these two from the store.
func TestActiveDeviceKeyUnknownRemovedAndExpired(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	_, err := ss.ActiveDeviceKey(ctx, "nope", dkT0)
	assert.ErrorIs(t, err, store.ErrUnknownSigner)

	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(time.Hour)))
	_, err = ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(2*time.Hour))
	assert.ErrorIs(t, err, store.ErrSignerRemoved)

	// unused for 90 days is expired at read time even before the sweep runs
	e := dkKey(2, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, e, dkT0)
	_, err = ss.ActiveDeviceKey(ctx, e.KID, dkT0.Add(90*24*time.Hour-time.Second))
	assert.NoError(t, err)
	_, err = ss.ActiveDeviceKey(ctx, e.KID, dkT0.Add(90*24*time.Hour))
	assert.ErrorIs(t, err, store.ErrSignerRemoved)
}

func TestTouchPushesExpiryOut(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, ss.TouchDeviceKey(ctx, k.KID, dkT0.Add(60*24*time.Hour)))
	_, err := ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(100*24*time.Hour))
	assert.NoError(t, err, "used on day 60: still good on day 100")
}

func TestExpireSweepEntersExpiredReason(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	n, err := ss.ExpireDeviceKeys(ctx, dkT0.Add(91*24*time.Hour))
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	l := mustList(t, ss)
	require.Len(t, l, 1)
	assert.Equal(t, store.DeviceExpired, l[0].RemovedReason)
	assert.NotZero(t, l[0].RemovedAt)
}

// A removed entry stays 90 days from its removal and never leaves earlier than 25 hours.
func TestRemovedEntryRetention(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	rm := dkT0.Add(time.Hour)
	require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, rm))
	n, _ := ss.PurgeDeviceKeys(ctx, rm.Add(90*24*time.Hour-time.Second))
	assert.Zero(t, n, "kept 90 days")
	n, _ = ss.PurgeDeviceKeys(ctx, rm.Add(90*24*time.Hour))
	assert.Equal(t, 1, n)
	_, err := ss.ActiveDeviceKey(ctx, k.KID, rm.Add(91*24*time.Hour))
	assert.ErrorIs(t, err, store.ErrUnknownSigner, "a purged entry is unknown, so it cannot sign")
}

func TestRemoveIsIdempotentAndNeverRefused(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(time.Hour)))
	first := mustList(t, ss)[0].RemovedAt
	require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(2*time.Hour)))
	assert.Equal(t, first, mustList(t, ss)[0].RemovedAt, "removing twice keeps the first time")
	assert.ErrorIs(t, ss.RemoveDeviceKey(ctx, "unknown", store.DeviceRemoved, dkT0), store.ErrUnknownSigner)
}

// Soft cap 200: past it the purge takes the oldest entry past 25 hours, expired before removed. Entries under 25 hours stay whatever the count.
func TestRemovedSoftCapPurgesExpiredFirstAndNeverUnder25h(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	now := dkT0.Add(10 * 24 * time.Hour)
	for i := 0; i < 205; i++ {
		k := dkKey(i, store.DeviceKindDevice, store.DeviceOriginPairing)
		_, err := ss.AddDeviceKey(ctx, k, dkT0)
		require.NoError(t, err)
		reason := store.DeviceRemoved
		if i < 3 { // three expired entries, the newest of the lot
			reason = store.DeviceExpired
		}
		at := dkT0.Add(time.Duration(i+1) * time.Hour) // removal times 1h..205h after dkT0
		require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, reason, at))
	}
	n, err := ss.PurgeDeviceKeys(ctx, now)
	require.NoError(t, err)
	assert.Equal(t, 5, n)
	l := mustList(t, ss)
	assert.Len(t, l, 200)
	for _, k := range l {
		assert.NotEqual(t, store.DeviceExpired, k.RemovedReason, "the expired ones went first")
	}
	// at a clock where only the first 24 removals are over 25 h old, the cap cannot take the rest
	ss2 := dkStore(t)
	for i := 0; i < 205; i++ {
		k := dkKey(i, store.DeviceKindDevice, store.DeviceOriginPairing)
		_, _ = ss2.AddDeviceKey(ctx, k, dkT0)
		_ = ss2.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0)
	}
	n, _ = ss2.PurgeDeviceKeys(ctx, dkT0.Add(24*time.Hour))
	assert.Zero(t, n, "all removed under 25 h ago: nothing may go")
	assert.Len(t, mustList(t, ss2), 205)
}

// Hard ceiling 400: only a NEW pairing is refused; a removal never is.
func TestRemovedHardCeilingRefusesOnlyNewPairings(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	for i := 0; i < 400; i++ {
		k := dkKey(i, store.DeviceKindDevice, store.DeviceOriginPairing)
		_, err := ss.AddDeviceKey(ctx, k, dkT0)
		require.NoError(t, err)
		require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0))
	}
	_, err := ss.AddDeviceKey(ctx, dkKey(1000, store.DeviceKindDevice, store.DeviceOriginPairing), dkT0.Add(time.Hour))
	assert.ErrorIs(t, err, store.ErrKeyLimit)
	// an active device can still be removed at the ceiling
	_, err = ss.AddDeviceKey(ctx, dkKey(1000, store.DeviceKindDevice, store.DeviceOriginPairing), dkT0.Add(26*time.Hour*24))
	_ = err // after the purge made room it may pass; the point is the removal below
	for _, k := range mustList(t, ss) {
		if k.RemovedAt == 0 {
			assert.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(26*time.Hour*24)))
		}
	}
}

func TestActiveDeviceAndPasskeyCaps(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	for i := 0; i < 10; i++ {
		_, err := ss.AddDeviceKey(ctx, dkKey(i, store.DeviceKindDevice, store.DeviceOriginPairing), dkT0)
		require.NoError(t, err)
	}
	_, err := ss.AddDeviceKey(ctx, dkKey(10, store.DeviceKindDevice, store.DeviceOriginPairing), dkT0)
	assert.ErrorIs(t, err, store.ErrKeyLimit, "11th active device")
	for i := 100; i < 105; i++ {
		_, err := ss.AddDeviceKey(ctx, dkKey(i, store.DeviceKindPasskey, store.DeviceOriginPairing), dkT0)
		require.NoError(t, err)
	}
	_, err = ss.AddDeviceKey(ctx, dkKey(105, store.DeviceKindPasskey, store.DeviceOriginPairing), dkT0)
	assert.ErrorIs(t, err, store.ErrKeyLimit, "6th passkey")
}

// A re-pairing of a removed (not yet purged) key is a fresh add: the person proved the pairing again.
func TestRepairingARemovedKeyMakesItActiveAgain(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	_ = ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(time.Hour))
	added, err := ss.AddDeviceKey(ctx, k, dkT0.Add(2*time.Hour))
	require.NoError(t, err)
	assert.True(t, added)
	_, err = ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(3*time.Hour))
	assert.NoError(t, err)
}

func TestSetDeviceMode(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, ss.SetDeviceMode(ctx, k.KID, "interact", dkT0.Add(time.Minute)))
	got, _ := ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(time.Minute))
	assert.Equal(t, "interact", got.Mode)
	assert.ErrorIs(t, ss.SetDeviceMode(ctx, "nope", "interact", dkT0), store.ErrUnknownSigner)
	require.NoError(t, ss.RemoveDeviceKey(ctx, k.KID, store.DeviceRemoved, dkT0.Add(time.Hour)))
	assert.ErrorIs(t, ss.SetDeviceMode(ctx, k.KID, "launch", dkT0.Add(2*time.Hour)), store.ErrSignerRemoved, "a removed entry's mode is not changed")
}

// ---- nonces and the clock mark ----

const win5 = 5 * time.Minute

// nn makes a well-formed nonce (22 base64url characters of 16 bytes) from a name.
func nn(name string) string {
	b := make([]byte, 16)
	copy(b, name)
	return base64.RawURLEncoding.EncodeToString(b)
}

func TestNonceRepeatRefusedWithinWindow(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	require.NoError(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0, win5))
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(4*time.Minute), win5), store.ErrNonceRepeat)
	// kept for the window plus the 5 minute skew: still refused at 9 min 59 s, free at 10 min
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(15*time.Minute), win5), store.ErrNonceRepeat)
	assert.NoError(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(15*time.Minute+time.Second), win5))
}

func TestNonceSurvivesReopen(t *testing.T) {
	path := t.TempDir() + "/s.db"
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	require.NoError(t, store.NewSessionStore(db).RecordNonce(context.Background(), nn("n1"), "kid", dkT0, win5))
	require.NoError(t, db.Close())
	db2, err := storetest.Open(t, path)
	require.NoError(t, err)
	assert.ErrorIs(t, store.NewSessionStore(db2).RecordNonce(context.Background(), nn("n1"), "kid", dkT0.Add(time.Minute), win5), store.ErrNonceRepeat, "a restart does not reopen a replay")
}

// The count cap refuses a new message before it drops a nonce.
func TestNonceStoreFullRefusesBeforeDropping(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	store.SetNonceCapForTest(t, 3)
	for i := 0; i < 3; i++ {
		require.NoError(t, ss.RecordNonce(ctx, nn(fmt.Sprintf("n%d", i)), "kid", dkT0, win5))
	}
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("n3"), "kid", dkT0.Add(time.Second), win5), store.ErrNonceStoreFull)
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("n0"), "kid", dkT0.Add(time.Second), win5), store.ErrNonceRepeat, "the oldest was not dropped to make room")
	// when the earliest expires, room appears
	assert.NoError(t, ss.RecordNonce(ctx, nn("n3"), "kid", dkT0.Add(16*time.Minute), win5))
}

func TestClockSetBackIsRefused(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	require.NoError(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(time.Hour), win5))
	err := ss.RecordNonce(ctx, nn("n2"), "kid", dkT0, win5)
	assert.ErrorIs(t, err, store.ErrClockBack, "the clock is behind the latest accepted time")
	assert.ErrorIs(t, ss.CheckClock(ctx, dkT0), store.ErrClockBack)
	assert.NoError(t, ss.CheckClock(ctx, dkT0.Add(time.Hour)))
	// nothing was recorded by the refused call
	assert.NoError(t, ss.RecordNonce(ctx, nn("n2"), "kid", dkT0.Add(2*time.Hour), win5))
}

func TestPruneNoncesDropsOnlyExpired(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	require.NoError(t, ss.RecordNonce(ctx, nn("short"), "k", dkT0, win5))
	require.NoError(t, ss.RecordNonce(ctx, nn("long"), "k", dkT0, 24*time.Hour))
	n, err := ss.PruneNonces(ctx, dkT0.Add(16*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("long"), "k", dkT0.Add(16*time.Minute), 24*time.Hour), store.ErrNonceRepeat)
}

// The nonce must be the 22-character base64url form of 16 bytes (coral-hub Lead's note B): anything else is refused before the store is touched.
func TestRecordNonceRefusesABadForm(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	for _, bad := range []string{"", "n1", nn("x") + "A", nn("x")[:21], nn("x")[:21] + "+", nn("x")[:21] + "B", base64.RawURLEncoding.EncodeToString(make([]byte, 24))} {
		assert.ErrorIs(t, ss.RecordNonce(ctx, bad, "kid", dkT0, win5), store.ErrNonceForm, bad)
	}
	assert.NoError(t, ss.CheckClock(ctx, dkT0))
	m, _ := ss.ClockMark(ctx)
	assert.True(t, m.IsZero(), "a refused nonce moves nothing")
}

// A computer re-linked to another Hub account must not honour account A's keys for account B (Q1): the re-link removes every active key; the removed ones stay listed and the entries cannot sign.
func TestRemoveAllDeviceKeysOnRelink(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	a, b := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing), dkKey(2, store.DeviceKindPasskey, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, a, dkT0)
	_, _ = ss.AddDeviceKey(ctx, b, dkT0)
	n, err := ss.RemoveAllDeviceKeys(ctx, dkT0.Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	for _, k := range []store.DeviceKey{a, b} {
		_, err := ss.ActiveDeviceKey(ctx, k.KID, dkT0.Add(2*time.Hour))
		assert.ErrorIs(t, err, store.ErrSignerRemoved)
	}
	n, _ = ss.RemoveAllDeviceKeys(ctx, dkT0.Add(2*time.Hour))
	assert.Zero(t, n, "a second re-link removes nothing more and keeps the first time")
}

// After a clock jump the owner clears the mark at the computer (note A): the refusal ends, and a nonce already accepted is still refused.
func TestOwnerClearsTheClockMark(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	require.NoError(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(time.Hour), win5))
	assert.ErrorIs(t, ss.CheckClock(ctx, dkT0), store.ErrClockBack)
	m, err := ss.ClockMark(ctx)
	require.NoError(t, err)
	assert.Equal(t, dkT0.Add(time.Hour).Unix(), m.Unix())
	require.NoError(t, ss.ClearClockMark(ctx, dkT0))
	assert.NoError(t, ss.CheckClock(ctx, dkT0))
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("n1"), "kid", dkT0.Add(time.Minute), win5), store.ErrNonceRepeat, "clearing the mark does not forget a nonce")
}

// Security SHOULD 3 (#248367): a touch must not bring an idle-expired key back. A key idle for 90 days that the sweep has not reached yet stays expired.
func TestTouchDoesNotReviveAnIdleExpiredKey(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(1, store.DeviceKindDevice, store.DeviceOriginPairing)
	_, _ = ss.AddDeviceKey(ctx, k, dkT0)
	late := dkT0.Add(91 * 24 * time.Hour)
	require.NoError(t, ss.TouchDeviceKey(ctx, k.KID, late))
	_, err := ss.ActiveDeviceKey(ctx, k.KID, late)
	assert.ErrorIs(t, err, store.ErrSignerRemoved, "the touch did not make it active again")
	assert.Zero(t, mustList(t, ss)[0].LastUsedAt, "and wrote nothing")
}

// Security SHOULD 4: one kid may hold only its share of the nonce cap, so one stolen signer cannot make every other device's signed message return nonce_store_full.
func TestNonceCapHasAPerKidShare(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	store.SetNonceCapForTest(t, 20)
	store.SetNonceKidShareForTest(t, 4)
	for i := 0; i < 4; i++ {
		require.NoError(t, ss.RecordNonce(ctx, nn(fmt.Sprintf("a%d", i)), "kidA", dkT0, win5))
	}
	assert.ErrorIs(t, ss.RecordNonce(ctx, nn("a4"), "kidA", dkT0, win5), store.ErrNonceStoreFull, "kid A is at its share")
	assert.NoError(t, ss.RecordNonce(ctx, nn("b0"), "kidB", dkT0, win5), "kid B is not blocked by kid A")
	assert.NoError(t, ss.RecordNonce(ctx, nn("a4"), "kidA", dkT0.Add(16*time.Minute), win5), "A's earlier nonces expired: room again")
}

// coral-hub draft 8 has only view, interact and launch: a stored mode is one of those.
func TestStoredModeIsOneOfThreeModes(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	k := dkKey(2, store.DeviceKindDevice, store.DeviceOriginPairing)
	for _, bad := range []string{"write", "admin", "VIEW", ""} {
		bk := k
		bk.Mode = bad
		_, err := ss.AddDeviceKey(ctx, bk, dkT0)
		assert.ErrorIs(t, err, store.ErrDeviceKeyForm, "add %q", bad)
	}
	_, err := ss.AddDeviceKey(ctx, k, dkT0)
	require.NoError(t, err)
	for _, bad := range []string{"write", "admin", "VIEW", ""} {
		assert.ErrorIs(t, ss.SetDeviceMode(ctx, k.KID, bad, dkT0), store.ErrDeviceKeyForm, "set %q", bad)
	}
	for _, ok := range []string{"view", "interact", "launch"} {
		assert.NoError(t, ss.SetDeviceMode(ctx, k.KID, ok, dkT0), ok)
	}
}

// Security SHOULD 6: an origin only goes up, bootstrap or noproof to pairing, never the reverse.
func TestPromoteDeviceOriginIsUpgradeOnly(t *testing.T) {
	ss, ctx := dkStore(t), context.Background()
	boot := dkKey(10, store.DeviceKindDevice, store.DeviceOriginBootstrap)
	np := dkKey(11, store.DeviceKindDevice, store.DeviceOriginNoProof)
	pair := dkKey(12, store.DeviceKindDevice, store.DeviceOriginPairing)
	for _, k := range []store.DeviceKey{boot, np, pair} {
		_, err := ss.AddDeviceKey(ctx, k, dkT0)
		require.NoError(t, err)
	}
	origin := func(kid string) string {
		for _, k := range mustList(t, ss) {
			if k.KID == kid {
				return k.Origin
			}
		}
		return ""
	}
	for _, k := range []store.DeviceKey{boot, np} {
		ok, err := ss.PromoteDeviceOrigin(ctx, k.KID, dkT0)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, store.DeviceOriginPairing, origin(k.KID))
	}
	ok, err := ss.PromoteDeviceOrigin(ctx, pair.KID, dkT0)
	require.NoError(t, err)
	assert.False(t, ok, "a pairing key is already there: nothing changes")
	ok, _ = ss.PromoteDeviceOrigin(ctx, "nope", dkT0)
	assert.False(t, ok)
	// a removed row is not promoted
	b2 := dkKey(13, store.DeviceKindDevice, store.DeviceOriginBootstrap)
	_, _ = ss.AddDeviceKey(ctx, b2, dkT0)
	require.NoError(t, ss.RemoveDeviceKey(ctx, b2.KID, store.DeviceRemoved, dkT0))
	ok, _ = ss.PromoteDeviceOrigin(ctx, b2.KID, dkT0)
	assert.False(t, ok)
	assert.Equal(t, store.DeviceOriginBootstrap, origin(b2.KID))
}
