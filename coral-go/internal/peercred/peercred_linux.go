//go:build linux

package peercred

import (
	"net/netip"
	"os"
	"time"
)

// Supported reports whether this platform can tell the peer's user.
const Supported = true

// ownerIsMe: the client socket's uid in /proc/net/tcp{,6} is this process's.
func ownerIsMe(client, server netip.AddrPort, _ time.Time) (bool, error) {
	uid, err := lookup(client, server)
	if err != nil {
		return false, err
	}
	return uid == os.Geteuid(), nil
}
