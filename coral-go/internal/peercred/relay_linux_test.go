//go:build linux

package peercred

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// WSL's localhost relay (#396): ALL four facts must hold, and each is flipped on its own below. The kernel's release string is read from a file, and the socket table from procNet.
func TestRelayOwnerNeedsAllFourFacts(t *testing.T) {
	dir := useTables(t)
	release := filepath.Join(t.TempDir(), "osrelease")
	oldRelease, oldEUID := osReleasePath, effectiveUID
	osReleasePath, effectiveUID = release, func() int { return coralUID }
	t.Cleanup(func() { osReleasePath, effectiveUID = oldRelease, oldEUID })

	writeRelease := func(s string) { require.NoError(t, os.WriteFile(release, []byte(s), 0o644)) }
	writeRelease("6.18.54.1-microsoft-standard-WSL2\n")
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: 0})

	assert.True(t, relayOwner(client, server), "loopback, Coral not root, a WSL kernel, the socket owned by root: the relay")
	assert.True(t, relayOwner(mappedCl, mappedSv), "the same, as IPv4-mapped addresses")

	// fact 1: both ends loopback
	remote := netip.MustParseAddrPort("192.168.1.20:51234")
	writeTable(t, dir, "tcp", row{local: remote, remote: server, state: established, uid: 0})
	assert.False(t, relayOwner(remote, server), "a client that is not on loopback")
	otherServer := netip.MustParseAddrPort("192.168.1.5:8420")
	writeTable(t, dir, "tcp", row{local: client, remote: otherServer, state: established, uid: 0})
	assert.False(t, relayOwner(client, otherServer), "a server address that is not loopback")
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: 0})

	// fact 2: Coral itself is not root (for root, uid 0 is the same user)
	effectiveUID = func() int { return 0 }
	assert.False(t, relayOwner(client, server), "Coral runs as root")
	effectiveUID = func() int { return coralUID }

	// fact 3: a WSL kernel, read from the file
	writeRelease("6.8.0-45-generic\n")
	assert.False(t, relayOwner(client, server), "an ordinary Linux kernel")
	writeRelease("5.10.16.3-Microsoft-standard\n")
	assert.True(t, relayOwner(client, server), "the kernel's spelling is not case-sensitive (WSL1 says Microsoft)")
	require.NoError(t, os.Remove(release))
	assert.False(t, relayOwner(client, server), "an unreadable release file")
	writeRelease("6.18.54.1-microsoft-standard-WSL2\n")

	// fact 4: the socket's owner is root
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: otherUID})
	assert.False(t, relayOwner(client, server), "the socket belongs to another user, not root")
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: coralUID})
	assert.False(t, relayOwner(client, server), "the socket is Coral's own user's")
	writeTable(t, dir, "tcp", row{local: netip.MustParseAddrPort("127.0.0.1:9999"), remote: server, state: established, uid: 0})
	assert.False(t, relayOwner(client, server), "no row for the connection: the owner can't be told")
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: 0})
	assert.True(t, relayOwner(client, server))
}

// Attribute on Linux, through the real owner check and the real relay check: the relay is its own verdict, a root socket off WSL is just another user, Coral's own socket is Self.
func TestAttributeNamesTheRelay(t *testing.T) {
	dir := useTables(t)
	release := filepath.Join(t.TempDir(), "osrelease")
	oldRelease, oldEUID := osReleasePath, effectiveUID
	osReleasePath, effectiveUID = release, func() int { return coralUID }
	t.Cleanup(func() { osReleasePath, effectiveUID = oldRelease, oldEUID })
	oldOwner := ownerCheck
	ownerCheck = func(c, s netip.AddrPort, _ time.Time) (bool, error) {
		uid, err := lookup(c, s)
		return uid == coralUID, err
	}
	t.Cleanup(func() { ownerCheck = oldOwner })

	require.NoError(t, os.WriteFile(release, []byte("6.18.54.1-microsoft-standard-WSL2\n"), 0o644))
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: 0})
	v, err := Attribute(client, server)
	require.NoError(t, err)
	assert.Equal(t, Relay, v)

	require.NoError(t, os.WriteFile(release, []byte("6.8.0-45-generic\n"), 0o644))
	v, _ = Attribute(client, server)
	assert.Equal(t, OtherUser, v, "root off WSL is another user")

	require.NoError(t, os.WriteFile(release, []byte("6.18.54.1-microsoft-standard-WSL2\n"), 0o644))
	writeTable(t, dir, "tcp", row{local: client, remote: server, state: established, uid: coralUID})
	v, _ = Attribute(client, server)
	assert.Equal(t, Self, v)
}
