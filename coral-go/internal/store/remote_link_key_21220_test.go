package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubproxy"
)

// Security's MUST 6 on #21220: a computer joined with a request key is stored with its key sealed like an API key, at https or this computer's own address only; an edit that would send the key in
// clear, or swap it, is refused with a plain reason.
func TestALinkKeyServerIsSealedAndNeverMovedToPlainHTTP(t *testing.T) {
	s, db, _, _ := newRemoteStore(t)
	ctx := context.Background()
	key := "lrk_0123abcd_" + strings.Repeat("f", 32)

	_, err := s.AddLinkKey(ctx, "lan", "LAN", "http://192.168.1.20:8420", key, true)
	assert.True(t, errors.Is(err, hubproxy.ErrLinkKeyPlainHTTP), "plain http to another computer: %v", err)
	_, err = s.AddLinkKey(ctx, "bad", "Bad", "https://box.example.com", "not-a-request-key", false)
	assert.Error(t, err)

	rs, err := s.AddLinkKey(ctx, "box", "Box", "https://box.example.com/", key, false)
	require.NoError(t, err)
	assert.Equal(t, RemoteKeyLink, rs.KeyKind)
	assert.Equal(t, "https://box.example.com", rs.URL)
	var env string
	require.NoError(t, db.GetContext(ctx, &env, "SELECT api_key FROM remote_servers WHERE id = 'box'"))
	assert.NotContains(t, env, strings.TrimPrefix(key, "lrk_"), "sealed, never plaintext")
	got, err := s.DecryptedKey(ctx, "box")
	require.NoError(t, err)
	assert.Equal(t, key, got)

	plain, other := "http://box.example.com", "an-api-key"
	_, err = s.Update(ctx, "box", RemoteServerUpdate{URL: &plain})
	assert.ErrorIs(t, err, ErrLinkKeyRemote)
	_, err = s.Update(ctx, "box", RemoteServerUpdate{APIKey: &other})
	assert.ErrorIs(t, err, ErrLinkKeyRemote)
	loop := "http://127.0.0.1:8420"
	_, err = s.Update(ctx, "box", RemoteServerUpdate{URL: &loop})
	assert.NoError(t, err, "this computer's own address is allowed")

	added, err := s.Add(ctx, "plain", "Plain", "http://127.0.0.1:9", "an-api-key", true)
	require.NoError(t, err)
	assert.Equal(t, RemoteKeyAPI, added.KeyKind, "every other server is an API key")
}
