//go:build !linux && !darwin && !windows

package peercred

import (
	"errors"
	"net/netip"
	"time"
)

// Supported reports whether this platform can tell the peer's user.
const Supported = false

func ownerIsMe(client, server netip.AddrPort, _ time.Time) (bool, error) {
	return false, errors.New("peercred: unsupported on this system")
}

// relayOwner: WSL's localhost relay is a Linux kernel's socket owner; nothing here is one.
func relayOwner(client, server netip.AddrPort) bool { return false }
