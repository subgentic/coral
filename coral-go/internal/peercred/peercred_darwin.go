//go:build darwin

package peercred

import (
	"net/netip"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Supported reports whether this platform can tell the peer's user.
const Supported = true

// ownerIsMe: the client socket's so_uid in the kernel's TCP table is this
// process's.
func ownerIsMe(client, server netip.AddrPort, _ time.Time) (bool, error) {
	b, err := unix.SysctlRaw("net.inet.tcp.pcblist_n")
	if err != nil {
		return false, err
	}
	uid, err := parsePCBList(b, client, server, hostLittleEndian)
	if err != nil {
		return false, err
	}
	return uid == os.Geteuid(), nil
}
