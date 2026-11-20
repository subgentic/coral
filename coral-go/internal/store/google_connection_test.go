package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20022: this database's Google sign-in: the refresh token is sealed by the master key and bound to the account id, moves with a key rotation, and is discarded by a re-key.

func googleStore(t *testing.T) (*GoogleStore, *RemoteServerStore, *DB) {
	t.Helper()
	db := openTestDB(t)
	rs := NewRemoteServerStore(db, t.TempDir())
	return NewGoogleStore(db, rs), rs, db
}

const fakeGoogleRefresh = "1//0g-refresh-0123456789abcdefghijklmnopqrstuvwxyz"

func TestTheGoogleTokenIsSealedAndBoundToTheAccount(t *testing.T) {
	gs, _, db := googleStore(t)
	ctx := context.Background()
	c, err := gs.Get(ctx)
	require.NoError(t, err)
	assert.False(t, c.Connected)
	_, err = gs.RefreshToken(ctx)
	assert.ErrorIs(t, err, ErrNoGoogleConnection)
	require.NoError(t, gs.Save(ctx, "acct-1", fakeGoogleRefresh))
	var raw string
	require.NoError(t, db.GetContext(ctx, &raw, "SELECT refresh_token FROM google_connection WHERE id = 1"))
	assert.NotContains(t, raw, fakeGoogleRefresh, "nothing in the database reads as the token")
	got, err := gs.RefreshToken(ctx)
	require.NoError(t, err)
	assert.Equal(t, fakeGoogleRefresh, got)
	c, _ = gs.Get(ctx)
	assert.True(t, c.Connected)
	assert.Equal(t, GoogleStateConnected, c.State)
	// bound to the account: the same envelope under another account id does not open
	_, err = db.ExecContext(ctx, "UPDATE google_connection SET account_id = 'acct-2' WHERE id = 1")
	require.NoError(t, err)
	_, err = gs.RefreshToken(ctx)
	assert.Error(t, err, "the account id is the AAD")
}

func TestDisconnectForgetsTheGoogleToken(t *testing.T) {
	gs, _, _ := googleStore(t)
	ctx := context.Background()
	require.NoError(t, gs.Save(ctx, "acct-1", fakeGoogleRefresh))
	require.NoError(t, gs.Disconnect(ctx))
	_, err := gs.RefreshToken(ctx)
	assert.ErrorIs(t, err, ErrNoGoogleConnection)
	c, _ := gs.Get(ctx)
	assert.False(t, c.Connected)
	assert.Equal(t, GoogleStateDisconnected, c.State)
	assert.Error(t, gs.SetState(ctx, "bogus"))
}

func TestAKeyRotationMovesTheGoogleToken(t *testing.T) {
	gs, rs, _ := googleStore(t)
	ctx := context.Background()
	require.NoError(t, gs.Save(ctx, "acct-1", fakeGoogleRefresh))
	require.NoError(t, rs.RotateMasterKey(ctx))
	got, err := gs.RefreshToken(ctx)
	require.NoError(t, err)
	assert.Equal(t, fakeGoogleRefresh, got, "the token moved with the key")
}

func TestARekeyDiscardsTheGoogleToken(t *testing.T) {
	rs, db, dir, _ := newRemoteStore(t)
	gs := NewGoogleStore(db, rs)
	ctx := context.Background()
	require.NoError(t, gs.Save(ctx, "acct-1", fakeGoogleRefresh))
	refuseTheKey(t, rs, dir)
	require.NoError(t, rs.Rekey(ctx))
	_, err := gs.RefreshToken(ctx)
	assert.ErrorIs(t, err, ErrNoGoogleConnection)
	var st string
	require.NoError(t, db.GetContext(ctx, &st, "SELECT state FROM google_connection WHERE id = 1"))
	assert.Equal(t, GoogleStateReconnect, st, "connect again")
	var tok sql.NullString
	require.NoError(t, db.GetContext(ctx, &tok, "SELECT refresh_token FROM google_connection WHERE id = 1"))
	assert.False(t, tok.Valid)
}
