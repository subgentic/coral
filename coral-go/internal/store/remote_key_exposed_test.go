package store

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A start that made the data folder private marks every stored server; the mark keeps its first time, and only a different key for that
// server clears it (its label or URL changing does not).
func TestAStoredKeyStaysMarkedUntilItIsReplaced(t *testing.T) {
	rs, _, _, _ := newRemoteStore(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b"} {
		_, err := rs.Add(ctx, id, id, "http://127.0.0.1:9", strings.Repeat("e4", 32), true)
		require.NoError(t, err)
	}
	a, err := rs.Get(ctx, "a")
	require.NoError(t, err)
	assert.Nil(t, a.KeyExposedSince, "not marked before")

	n, err := rs.MarkKeysExposed(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)
	a, err = rs.Get(ctx, "a")
	require.NoError(t, err)
	require.NotNil(t, a.KeyExposedSince)
	first := *a.KeyExposedSince

	n, err = rs.MarkKeysExposed(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 0, n, "a second open start keeps the first time")

	label := "renamed"
	_, err = rs.Update(ctx, "a", RemoteServerUpdate{Label: &label})
	require.NoError(t, err)
	a, err = rs.Get(ctx, "a")
	require.NoError(t, err)
	require.NotNil(t, a.KeyExposedSince, "a new label does not clear it")
	assert.Equal(t, first, *a.KeyExposedSince)

	same := strings.Repeat("e4", 32)
	_, err = rs.Update(ctx, "a", RemoteServerUpdate{APIKey: &same})
	require.NoError(t, err)
	a, err = rs.Get(ctx, "a")
	require.NoError(t, err)
	require.NotNil(t, a.KeyExposedSince, "the same key entered again does not clear it")

	key := strings.Repeat("f5", 32)
	_, err = rs.Update(ctx, "a", RemoteServerUpdate{APIKey: &key})
	require.NoError(t, err)
	a, err = rs.Get(ctx, "a")
	require.NoError(t, err)
	assert.Nil(t, a.KeyExposedSince, "a different key clears it")
	b, err := rs.Get(ctx, "b")
	require.NoError(t, err)
	assert.NotNil(t, b.KeyExposedSince, "and only for that server")
}

// A stored key that can't be read counts as different: entering a key then clears the mark.
func TestAnUnreadableStoredKeyCountsAsDifferent(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	ctx := context.Background()
	_, err := rs.Add(ctx, "a", "a", "http://127.0.0.1:9", strings.Repeat("e4", 32), true)
	require.NoError(t, err)
	_, err = rs.MarkKeysExposed(ctx)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "UPDATE remote_servers SET api_key = 'v1:not-a-sealed-key' WHERE id = 'a'")
	require.NoError(t, err)
	_, err = rs.DecryptedKey(ctx, "a")
	require.Error(t, err, "the setup: the stored key can't be read")

	same := strings.Repeat("e4", 32)
	_, err = rs.Update(ctx, "a", RemoteServerUpdate{APIKey: &same})
	require.NoError(t, err)
	a, err := rs.Get(ctx, "a")
	require.NoError(t, err)
	assert.Nil(t, a.KeyExposedSince)
}
