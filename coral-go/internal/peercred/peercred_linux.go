//go:build linux

package peercred

import (
	"net/netip"
	"os"
	"strings"
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

// osReleasePath is the kernel's release string (a test seam): a WSL kernel's contains "microsoft" ("5.15.153.1-microsoft-standard-WSL2", or "...-Microsoft" on WSL1).
var osReleasePath = "/proc/sys/kernel/osrelease"

// effectiveUID is os.Geteuid (a test seam).
var effectiveUID = os.Geteuid

// relayOwner: whether the client socket is WSL's localhost relay (#396). ALL four must hold, each read fresh: both ends are loopback; Coral itself does not run as root (for root, uid 0 is
// the same user); the kernel is a WSL one, read from osReleasePath; and the socket's owner in the kernel's table is uid 0. Anything else (an unreadable file, a failed lookup) is false.
func relayOwner(client, server netip.AddrPort) bool {
	if !client.Addr().Unmap().IsLoopback() || !server.Addr().Unmap().IsLoopback() {
		return false
	}
	if effectiveUID() == 0 {
		return false
	}
	release, err := os.ReadFile(osReleasePath)
	if err != nil || !strings.Contains(strings.ToLower(string(release)), "microsoft") {
		return false
	}
	uid, err := lookup(client, server)
	return err == nil && uid == 0
}
