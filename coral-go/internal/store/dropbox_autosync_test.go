package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14714 auto-sync. Mutants: off by default; a pause lifted by anything but Resume; another account's sign-in, a disconnect or a re-key not pausing it.
func TestAutoSyncIsOnByDefaultAndPausedByAChangeOfSignIn(t *testing.T) {
	rs, db, dir, _ := newRemoteStore(t)
	ds := NewDropboxStore(db, rs)
	ctx := context.Background()
	on, paused, err := ds.AutoSync(ctx)
	require.NoError(t, err)
	assert.True(t, on, "on, as the Operator asked")
	assert.Empty(t, paused)
	require.NoError(t, ds.Save(ctx, "dbid:A", "refresh", "fp"))
	_, paused, _ = ds.AutoSync(ctx)
	assert.Empty(t, paused, "a first sign-in does not pause it")
	require.NoError(t, ds.Save(ctx, "dbid:A", "refresh2", "fp"))
	_, paused, _ = ds.AutoSync(ctx)
	assert.Empty(t, paused, "the same account again does not pause it")
	require.NoError(t, ds.Save(ctx, "dbid:B", "refresh3", "fp"))
	_, paused, _ = ds.AutoSync(ctx)
	assert.Equal(t, AutoSyncPausedSignIn, paused, "another account pauses it")
	require.NoError(t, ds.SetAutoSync(ctx, true))
	require.NoError(t, ds.Disconnect(ctx))
	_, paused, _ = ds.AutoSync(ctx)
	assert.Equal(t, AutoSyncPausedSignIn, paused, "a disconnect pauses it")
	require.NoError(t, ds.SetAutoSync(ctx, true))
	require.NoError(t, ds.Save(ctx, "dbid:B", "refresh4", "fp"))
	refuseTheKey(t, rs, dir) // a re-key is allowed
	require.NoError(t, rs.Rekey(ctx))
	_, paused, _ = ds.AutoSync(ctx)
	assert.Equal(t, AutoSyncPausedSignIn, paused, "a re-key pauses it")
	require.NoError(t, ds.SetAutoSync(ctx, false))
	on, _, _ = ds.AutoSync(ctx)
	assert.False(t, on)
	assert.Error(t, ds.PauseAutoSync(ctx, "whatever"))
}
