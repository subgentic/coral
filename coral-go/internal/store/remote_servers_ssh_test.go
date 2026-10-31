package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11370: a server the provisioner set up is reached over the owner's SSH session. Only AddSSH makes one, an id or an instance already registered is never replaced, and a URL cannot be put on it.
func TestRemoteServers_SSHTransport(t *testing.T) {
	s, _, _, _ := newRemoteStore(t)
	ctx := context.Background()

	plain, err := s.Add(ctx, "web", "By URL", "http://10.0.0.5:8420", plainKey, true)
	require.NoError(t, err)
	assert.Equal(t, RemoteTransportHTTP, plain.Transport, "a server added by URL is http")

	srv, err := s.AddSSH(ctx, "build", "Build box", "user@box.example.com:2222", 8420, "inst-1", plainKey)
	require.NoError(t, err)
	assert.Equal(t, RemoteTransportSSH, srv.Transport)
	assert.Equal(t, "user@box.example.com:2222", srv.SSHTarget)
	assert.Equal(t, 8420, srv.RemotePort)
	assert.Equal(t, "inst-1", srv.InstanceID)
	key, err := s.DecryptedKey(ctx, "build")
	require.NoError(t, err)
	assert.Equal(t, plainKey, key)

	b, _ := json.Marshal(srv)
	assert.NotContains(t, string(b), "inst-1", "the instance id never leaves the hub in JSON")
	assert.NotContains(t, string(b), "remote_port")
	assert.NotContains(t, string(b), plainKey)

	// never replaces: the same id, and the same machine under another id
	_, err = s.AddSSH(ctx, "build", "Other", "user@other.example.com", 8420, "inst-2", "another-key-1234")
	assert.ErrorIs(t, err, ErrRemoteExists)
	_, err = s.AddSSH(ctx, "build2", "Same machine", "user@box.example.com:2222", 8420, "inst-1", "another-key-1234")
	assert.ErrorIs(t, err, ErrRemoteInstanceExists)
	_, err = s.AddSSH(ctx, "web", "Takes a URL server's id", "user@x.example.com", 8420, "inst-3", "another-key-1234")
	assert.ErrorIs(t, err, ErrRemoteExists)
	if key, _ := s.DecryptedKey(ctx, "web"); key != plainKey {
		t.Errorf("an existing server's key was replaced")
	}
	id, err := s.FindByInstance(ctx, "inst-1")
	require.NoError(t, err)
	assert.Equal(t, "build", id)
	id, _ = s.FindByInstance(ctx, "nope")
	assert.Equal(t, "", id)
	id, _ = s.FindByInstance(ctx, "")
	assert.Equal(t, "", id, "no instance id matches nothing, not every URL server")

	// incomplete input
	for _, bad := range []struct {
		target, inst, key string
		port              int
	}{{"", "i", "k", 8420}, {"u@h", "", "k", 8420}, {"u@h", "i", "", 8420}, {"u@h", "i", "k", 0}, {"u@h", "i", "k", 70000}} {
		_, err := s.AddSSH(ctx, "x-"+strings.ReplaceAll(bad.inst, "", "a"), "L", bad.target, bad.port, bad.inst, bad.key)
		assert.Error(t, err, "%+v", bad)
	}

	// a URL cannot be put on it, a label can
	u := "http://evil.example.com:8420"
	_, err = s.Update(ctx, "build", RemoteServerUpdate{URL: &u})
	assert.ErrorIs(t, err, ErrRemoteTransport)
	got, _ := s.Get(ctx, "build")
	assert.Equal(t, "ssh://user@box.example.com:2222", got.URL)
	l := "Renamed"
	got, err = s.Update(ctx, "build", RemoteServerUpdate{Label: &l})
	require.NoError(t, err)
	assert.Equal(t, "Renamed", got.Label)
	assert.Equal(t, RemoteTransportSSH, got.Transport)

	all, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, all, 2)
}

// Two AddSSH calls that both pass the FindByInstance check (a race) cannot both insert: the unique index refuses the second, and AddSSH says it is the same machine.
func TestRemoteServers_InstanceIsUniqueInTheDatabase(t *testing.T) {
	s, db, _, _ := newRemoteStore(t)
	ctx := context.Background()
	_, err := s.AddSSH(ctx, "one", "One", "u@h1", 8420, "inst-1", plainKey)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO remote_servers (id, label, url, api_key, status, created_at, transport, ssh_target, remote_port, instance_id)
		VALUES ('two', 'Two', 'ssh://u@h2', 'x', 'unknown', 'now', 'ssh', 'u@h2', 8420, 'inst-1')`)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote_servers.instance_id")
	// servers added by URL have no instance id, and any number of them may exist
	_, err = s.Add(ctx, "a", "A", "http://10.0.0.5:8420", plainKey, true)
	require.NoError(t, err)
	_, err = s.Add(ctx, "b", "B", "http://10.0.0.6:8420", plainKey, true)
	require.NoError(t, err)
}

func TestRemoteServers_UpdateOfAMissingServerIsNotFound(t *testing.T) {
	s, _, _, _ := newRemoteStore(t)
	u := "http://10.0.0.5:8420"
	_, err := s.Update(context.Background(), "ghost", RemoteServerUpdate{URL: &u})
	assert.ErrorIs(t, err, ErrRemoteNotFound)
}
