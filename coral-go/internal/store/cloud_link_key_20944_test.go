package store

import (
	"context"
	"strings"
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
