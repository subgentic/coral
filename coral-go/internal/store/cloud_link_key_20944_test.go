package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20944 (design #20901 v5 to v7): a self-hosted Hub's request key. Named, one per Hub, shown once, stored only as a salted hash, revocable.

func keyRig(t *testing.T) (*CloudStore, context.Context, time.Time) {
	return reqRig(t)
}

func TestARequestKeyIsShownOnceStoredHashedAndVerifies(t *testing.T) {
	cs, ctx, now := keyRig(t)
	id, key, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(key, "lrk_"), key)
	var raw string
	require.NoError(t, cs.db.GetContext(ctx, &raw, `SELECT group_concat(key_id || key_salt || key_hash || name, '|') FROM cloud_link_key`))
	assert.NotContains(t, raw, key, "the key is kept only as a hash")
	got, ok := cs.VerifyLinkKey(ctx, key, now.Add(time.Minute))
	require.True(t, ok)
	assert.Equal(t, id, got.ID)
	assert.Equal(t, "Hub C", got.Name)
	// Wrong secret, unknown id, malformed: no.
	for _, bad := range []string{key + "0", key[:len(key)-1] + "x", "lrk_nope_" + strings.Repeat("a", 32), "", "lrk_", id, "Bearer " + key} {
		_, ok := cs.VerifyLinkKey(ctx, bad, now)
		assert.False(t, ok, bad)
	}
}

func TestListingKeysNeverShowsTheKeyAndShowsLastUse(t *testing.T) {
	cs, ctx, now := keyRig(t)
	_, key, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	ks, err := cs.ListLinkKeys(ctx)
	require.NoError(t, err)
	require.Len(t, ks, 1)
	assert.Equal(t, "Hub C", ks[0].Name)
	assert.True(t, ks[0].LastUsedAt.IsZero())
	_, ok := cs.VerifyLinkKey(ctx, key, now.Add(time.Hour))
	require.True(t, ok)
	ks, _ = cs.ListLinkKeys(ctx)
	assert.Equal(t, now.Add(time.Hour).UTC().Format(ISOFormat), ks[0].LastUsedAt.UTC().Format(ISOFormat))
}

func TestRevokingAKeyStopsItAndEndsItsWaitingRequests(t *testing.T) {
	cs, ctx, now := keyRig(t)
	id, key, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", id, now)
	require.NoError(t, err)
	ps, _ := cs.PendingLinkRequests(ctx, now)
	require.Len(t, ps, 1)
	assert.Equal(t, "Hub C", ps[0].Via, "the card says which key asked")
	require.NoError(t, cs.RevokeLinkKey(ctx, id, now))
	_, ok := cs.VerifyLinkKey(ctx, key, now)
	assert.False(t, ok)
	ps, _ = cs.PendingLinkRequests(ctx, now)
	assert.Empty(t, ps, "a revoked key's waiting request is gone")
	assert.ErrorIs(t, cs.RevokeLinkKey(ctx, id, now), ErrLinkKeyNone, "twice is not a second revoke")
	assert.ErrorIs(t, cs.RevokeLinkKey(ctx, "nope", now), ErrLinkKeyNone)
}

func TestAKeyNeedsAGoodNameAndTheLimitsHold(t *testing.T) {
	cs, ctx, now := keyRig(t)
	for _, n := range []string{"", "  ", strings.Repeat("a", 41), "bad\nname", "x\x00y"} {
		_, _, err := cs.CreateLinkKey(ctx, n, now)
		assert.ErrorIs(t, err, ErrLinkKeyName, n)
	}
	id, _, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	_, _, err = cs.CreateLinkKey(ctx, "hub c", now)
	assert.ErrorIs(t, err, ErrLinkKeyName, "a live name is not reused")
	require.NoError(t, cs.RevokeLinkKey(ctx, id, now))
	_, _, err = cs.CreateLinkKey(ctx, "Hub C", now)
	assert.NoError(t, err, "a revoked key's name can be used again")
	for i := 0; i < MaxLinkKeys-1; i++ {
		_, _, err = cs.CreateLinkKey(ctx, "Hub "+string(rune('D'+i)), now)
		if i < MaxLinkKeys-2 {
			require.NoError(t, err)
		}
	}
	_, _, err = cs.CreateLinkKey(ctx, "one too many", now)
	assert.ErrorIs(t, err, ErrLinkKeyLimit)
}

// Security's SHOULD 6 on #20936: the per-credential limits count per key, not in one shared bucket.
func TestRequestLimitsCountPerKey(t *testing.T) {
	cs, ctx, now := keyRig(t)
	a, _, err := cs.CreateLinkKey(ctx, "Hub A2", now)
	require.NoError(t, err)
	b, _, err := cs.CreateLinkKey(ctx, "Hub B2", now)
	require.NoError(t, err)
	for i := 0; i < linkRequestPerCred; i++ {
		_, _, err := cs.CreateLinkRequest(ctx, "https://hub-"+string(rune('c'+i))+".example.com", "view", a, now)
		require.NoError(t, err)
	}
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-z.example.com", "view", a, now)
	assert.ErrorIs(t, err, ErrLinkRequestBusy, "key A is at its limit")
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-y.example.com", "view", b, now)
	assert.NoError(t, err, "key B has its own")
}

// QA's SHOULD 2 on #20936: the count and the insert are one write-first transaction, so two creates at once for one Hub cannot both pass the one-waiting limit.
func TestTwoCreatesAtOnceForOneHubMakeOneRequest(t *testing.T) {
	cs, ctx, now := keyRig(t)
	var wg sync.WaitGroup
	var made, busy atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := cs.CreateLinkRequest(ctx, "https://hub-race.example.com", "view", "", now)
			switch {
			case err == nil:
				made.Add(1)
			case errors.Is(err, ErrLinkRequestBusy):
				busy.Add(1)
			}
		}()
	}
	wg.Wait()
	assert.EqualValues(t, 1, made.Load())
	assert.EqualValues(t, 7, busy.Load())
}

// A run of wrong codes is guessing, so it counts toward the mute, and the refusal says so.
func TestTheMuteSaysWrongCodesCountToo(t *testing.T) {
	assert.Contains(t, ErrLinkRequestMuted.Error(), "wrong codes")
}

// #20966: a key made through a Hub (a relayed make) carries the link it came through: at most 3 live ones and 10 made an hour per link, and a Hub can end only its own link's.
func TestKeysMadeThroughALinkAreCappedPerLinkAndEndedOnlyByIt(t *testing.T) {
	cs, ctx, now := reqRig(t)
	var ids []string
	for i := 0; i < 3; i++ {
		id, key, err := cs.CreateLinkKeyVia(ctx, fmt.Sprintf("Hub %d", i), "lnk-aaaa1111", now)
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(key, "lrk_"))
		ids = append(ids, id)
	}
	_, _, err := cs.CreateLinkKeyVia(ctx, "Hub 3", "lnk-aaaa1111", now)
	assert.ErrorIs(t, err, ErrLinkKeyLinkLimit, "a fourth live key through one link")
	_, _, err = cs.CreateLinkKeyVia(ctx, "Hub 3", "lnk-bbbb2222", now)
	assert.NoError(t, err, "another link has its own three")

	assert.ErrorIs(t, cs.RevokeLinkKeyVia(ctx, ids[0], "lnk-bbbb2222", now), ErrLinkKeyNone, "another link cannot end it, and learns nothing")
	assert.ErrorIs(t, cs.RevokeLinkKeyVia(ctx, "lk-00000000", "lnk-aaaa1111", now), ErrLinkKeyNone)
	require.NoError(t, cs.RevokeLinkKeyVia(ctx, ids[0], "lnk-aaaa1111", now))
	local, _, err := cs.CreateLinkKey(ctx, "At the computer", now)
	require.NoError(t, err)
	assert.ErrorIs(t, cs.RevokeLinkKeyVia(ctx, local, "lnk-aaaa1111", now), ErrLinkKeyNone, "a key made at the computer is ended at the computer")
}

func TestTenCreationsAnHourPerLinkCountRevokedOnesToo(t *testing.T) {
	cs, ctx, now := reqRig(t)
	for i := 0; i < 10; i++ {
		id, _, err := cs.CreateLinkKeyVia(ctx, fmt.Sprintf("Hub %d", i), "lnk-aaaa1111", now.Add(time.Duration(i)*time.Minute))
		require.NoError(t, err, i)
		require.NoError(t, cs.RevokeLinkKeyVia(ctx, id, "lnk-aaaa1111", now.Add(time.Duration(i)*time.Minute)))
	}
	_, _, err := cs.CreateLinkKeyVia(ctx, "Hub x", "lnk-aaaa1111", now.Add(11*time.Minute))
	assert.ErrorIs(t, err, ErrLinkKeyRate, "an eleventh in the hour, though none is live")
	_, _, err = cs.CreateLinkKeyVia(ctx, "Hub x", "lnk-aaaa1111", now.Add(75*time.Minute))
	assert.NoError(t, err, "an hour later")
}
