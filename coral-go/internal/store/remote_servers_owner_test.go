package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const ownerSecretA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const ownerSecretB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// #11378: the secret a hub signs a remote's owner stamps with is sealed under the master key with its own AAD, never shown, and moves with a rotation.
func TestRemoteServers_OwnerSecretIsSealedSeparatelyAndNeverShown(t *testing.T) {
	s, db, _, _ := newRemoteStore(t)
	ctx := context.Background()
	_, err := s.AddSSH(ctx, "box", "Box", "rich@box.example.com:22", 8420, "inst-1", plainKey)
	require.NoError(t, err)
	srv, _ := s.Get(ctx, "box")
	assert.False(t, srv.OwnerStamp, "no secret yet")
	if _, ok, err := s.OwnerSecret(ctx, "box"); ok || err != nil {
		t.Fatalf("no secret yet: %v %v", ok, err)
	}

	require.NoError(t, s.SetOwnerSecret(ctx, "box", ownerSecretA))
	got, ok, err := s.OwnerSecret(ctx, "box")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, ownerSecretA, got)
	srv, _ = s.Get(ctx, "box")
	assert.True(t, srv.OwnerStamp)
	b, _ := json.Marshal(srv)
	assert.Contains(t, string(b), `"owner_stamp":true`)
	assert.NotContains(t, string(b), ownerSecretA)

	var env string
	require.NoError(t, db.GetContext(ctx, &env, "SELECT owner_secret FROM remote_servers WHERE id = 'box'"))
	assert.NotContains(t, env, ownerSecretA, "stored in the clear")
	assert.True(t, strings.HasPrefix(env, "v1:"), env)

	// replaced by a new one
	require.NoError(t, s.SetOwnerSecret(ctx, "box", ownerSecretB))
	got, _, _ = s.OwnerSecret(ctx, "box")
	assert.Equal(t, ownerSecretB, got)

	// invalid input and a missing server
	assert.Error(t, s.SetOwnerSecret(ctx, "box", "short"))
	assert.Error(t, s.SetOwnerSecret(ctx, "box", strings.ToUpper(ownerSecretA)))
	assert.ErrorIs(t, s.SetOwnerSecret(ctx, "ghost", ownerSecretA), ErrRemoteNotFound)
	_, _, err = s.OwnerSecret(ctx, "ghost")
	assert.ErrorIs(t, err, ErrRemoteNotFound)
	got, _, _ = s.OwnerSecret(ctx, "box")
	assert.Equal(t, ownerSecretB, got, "a refused set changed the secret")
}

// The two envelopes of a server cannot be swapped: the API key's AAD is the id, the owner secret's is the id and a marker.
func TestRemoteServers_OwnerSecretAndKeyEnvelopesCannotBeSwapped(t *testing.T) {
	s, db, _, _ := newRemoteStore(t)
	ctx := context.Background()
	_, err := s.AddSSH(ctx, "box", "Box", "rich@box.example.com:22", 8420, "inst-1", plainKey)
	require.NoError(t, err)
	require.NoError(t, s.SetOwnerSecret(ctx, "box", ownerSecretA))
	_, err = db.ExecContext(ctx, "UPDATE remote_servers SET owner_secret = api_key WHERE id = 'box'") // a stolen database row copy
	require.NoError(t, err)
	_, ok, err := s.OwnerSecret(ctx, "box")
	assert.False(t, ok)
	assert.ErrorIs(t, err, ErrKeyUnreadable, "the API key's envelope opened as an owner secret")
}

func TestRemoteServers_RotatingTheMasterKeyKeepsTheOwnerSecretsReadable(t *testing.T) {
	s, _, _, _ := newRemoteStore(t)
	ctx := context.Background()
	_, err := s.AddSSH(ctx, "box", "Box", "u@box.example.com:22", 8420, "inst-1", plainKey)
	require.NoError(t, err)
	_, err = s.AddSSH(ctx, "nosecret", "No secret", "u@other.example.com:22", 8420, "inst-2", "another-key-0123456789")
	require.NoError(t, err)
	_, err = s.Add(ctx, "web", "By URL", "http://10.0.0.5:8420", "web-key-0123456789", true)
	require.NoError(t, err)
	require.NoError(t, s.SetOwnerSecret(ctx, "box", ownerSecretA))

	require.NoError(t, s.RotateMasterKey(ctx))

	got, ok, err := s.OwnerSecret(ctx, "box")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, ownerSecretA, got, "the owner secret did not survive the rotation")
	for id, want := range map[string]string{"box": plainKey, "nosecret": "another-key-0123456789", "web": "web-key-0123456789"} {
		k, err := s.DecryptedKey(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, want, k, id)
	}
	_, ok, err = s.OwnerSecret(ctx, "nosecret")
	assert.False(t, ok)
	assert.NoError(t, err)
}
