package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/secretbox"
)

// #14609, Dropbox stage 3a: this database's Dropbox sign-in. The refresh token is sealed by the master key and bound to the account id; the server id
// belongs to the database (made once, kept through a disconnect); the machine fingerprint is a keyed pseudonym of the machine and the data folder.

func dropboxStore(t *testing.T) (*DropboxStore, *RemoteServerStore, *DB) {
	t.Helper()
	db := openTestDB(t)
	rs := NewRemoteServerStore(db, t.TempDir())
	return NewDropboxStore(db, rs), rs, db
}

const fakeRefresh = "dbx-refresh-0123456789abcdefghijklmnopqrstuvwxyz"

func TestDropboxServerIDIsMadeOnceAndBelongsToTheDatabase(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	a, err := ds.ServerID(ctx)
	require.NoError(t, err)
	assert.Regexp(t, `^[0-9a-f]{32}$`, a)
	b, err := ds.ServerID(ctx)
	require.NoError(t, err)
	assert.Equal(t, a, b, "made once")
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, "fp"))
	require.NoError(t, ds.Disconnect(ctx))
	c, err := ds.ServerID(ctx)
	require.NoError(t, err)
	assert.Equal(t, a, c, "a disconnect keeps the server id: it belongs to the database")
}

func TestDropboxRefreshTokenIsSealedAndBoundToTheAccount(t *testing.T) {
	ds, _, db := dropboxStore(t)
	ctx := context.Background()
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, "fp"))
	var raw string
	require.NoError(t, db.GetContext(ctx, &raw, "SELECT refresh_token FROM dropbox_connection WHERE id = 1"))
	assert.True(t, strings.HasPrefix(raw, "v1:"), "a secretbox envelope")
	assert.NotContains(t, raw, fakeRefresh, "never plaintext")
	tok, err := ds.RefreshToken(ctx)
	require.NoError(t, err)
	assert.Equal(t, fakeRefresh, tok)

	_, err = db.ExecContext(ctx, "UPDATE dropbox_connection SET account_id = 'dbid:BBB' WHERE id = 1")
	require.NoError(t, err)
	_, err = ds.RefreshToken(ctx)
	assert.Error(t, err, "the token is bound to its account: a changed account id cannot open it")
}

func TestDropboxGetNeverCarriesTheToken(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	c, err := ds.Get(ctx)
	require.NoError(t, err)
	assert.False(t, c.Connected)
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, "fp"))
	c, err = ds.Get(ctx)
	require.NoError(t, err)
	assert.True(t, c.Connected)
	assert.Equal(t, "dbid:AAA", c.AccountID)
	assert.NotContains(t, strings.ToLower(strings.Join([]string{c.AccountID, c.State, c.ConnectedAt, c.ServerID}, " ")), "refresh")
}

func TestDropboxDisconnectForgetsTheTokenAndTheAccount(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, "fp"))
	require.NoError(t, ds.Disconnect(ctx))
	_, err := ds.RefreshToken(ctx)
	assert.ErrorIs(t, err, ErrNoDropboxConnection)
	c, err := ds.Get(ctx)
	require.NoError(t, err)
	assert.False(t, c.Connected)
	assert.Equal(t, "dbid:AAA", c.LastAccountID, "the last account is kept, so a reconnect to another account is a confirmed switch")
}

func TestARekeyDiscardsTheDropboxTokenAndKeepsTheServerID(t *testing.T) {
	rs, db, dir, _ := newRemoteStore(t)
	ds := NewDropboxStore(db, rs)
	ctx := context.Background()
	id, err := ds.ServerID(ctx)
	require.NoError(t, err)
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, "fp"))
	require.NoError(t, os.Chmod(secretbox.KeyFilePath(dir), 0o644)) // the key is refused (other accounts can read it): a re-key is allowed
	require.NoError(t, rs.Rekey(ctx))
	_, err = ds.RefreshToken(ctx)
	assert.ErrorIs(t, err, ErrNoDropboxConnection, "a re-key discards every sealed secret, the Dropbox token too")
	after, err := ds.ServerID(ctx)
	require.NoError(t, err)
	assert.Equal(t, id, after)
	c, err := ds.Get(ctx)
	require.NoError(t, err)
	assert.Equal(t, DropboxStateReconnect, c.State, "the settings page asks to connect again")
}

func TestAKeyRotationKeepsTheDropboxTokenReadableAndTheFingerprintTrue(t *testing.T) {
	ds, rs, _ := dropboxStore(t)
	ctx := context.Background()
	fp, err := ds.Fingerprint(ctx, "machine-1", "/data")
	require.NoError(t, err)
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, fp))
	ok, err := ds.FingerprintMatches(ctx, "machine-1", "/data")
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, rs.RotateMasterKey(ctx))
	tok, err := ds.RefreshToken(ctx)
	require.NoError(t, err, "the Dropbox token moves to the new key with the others")
	assert.Equal(t, fakeRefresh, tok)
	ok, err = ds.FingerprintMatches(ctx, "machine-1", "/data")
	require.NoError(t, err)
	assert.True(t, ok, "a rotation recomputes the fingerprint, so this computer is not mistaken for a copy")
}

func TestTheFingerprintTellsAnotherMachineOrDataFolder(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	fp, err := ds.Fingerprint(ctx, "machine-1", "/data")
	require.NoError(t, err)
	require.NoError(t, ds.Save(ctx, "dbid:AAA", fakeRefresh, fp))
	assert.NotContains(t, fp, "machine-1", "a keyed pseudonym, never the machine id itself")
	var salt string
	require.NoError(t, ds.db.GetContext(ctx, &salt, "SELECT fp_salt FROM dropbox_connection WHERE id = 1"))
	assert.Regexp(t, `^[0-9a-f]{64}$`, salt, "32 random bytes")
	for _, c := range []struct{ machine, dir string }{{"machine-2", "/data"}, {"machine-1", "/other"}} {
		ok, err := ds.FingerprintMatches(ctx, c.machine, c.dir)
		require.NoError(t, err)
		assert.False(t, ok, "%s %s is a copy", c.machine, c.dir)
	}
	require.NoError(t, ds.TakeOver(ctx, "machine-2", "/data"))
	ok, err := ds.FingerprintMatches(ctx, "machine-2", "/data")
	require.NoError(t, err)
	assert.True(t, ok, "Take over records this computer")
}
