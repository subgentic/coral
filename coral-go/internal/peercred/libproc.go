package peercred

import (
	"encoding/binary"
	"net/netip"
)

// macOS 27 shows a process signed the usual way (the published releases) none of the other processes' sockets in net.inet.tcp.pcblist_n (#12529). What libproc reads is not hidden: the
// proc_info call lists a process's file descriptors and describes a socket one (struct socket_fdinfo, sys/proc_info.h, a stable public ABI), for the processes of the caller's own user,
// which is the only owner Coral wants to recognise. A client socket found in one of them is the user's own; one found in none is another user's or nobody's, and is refused as it always was.
// Parsed here, on every system, so the tests can feed it bytes.
const (
	sockFdinfoSize = 792 // sizeof(struct socket_fdinfo): PROC_PIDFDSOCKETINFO_SIZE
	sockFdinfoKind = 256 // soi_kind: SOCKINFO_IN 1, SOCKINFO_TCP 2
	sockFdinfoIn   = 264 // the in_sockinfo (a tcp_sockinfo begins with one)
	inFPort        = 0   // i32, network order in its first two bytes
	inLPort        = 4
	inVFlag        = 24 // INI_IPV4 1, INI_IPV6 2
	inFAddr        = 32 // 16 bytes: in6_addr, or an IPv4 address in the last 4
	inLAddr        = 48

	sockinfoIn  = 1
	sockinfoTCP = 2
)

// parseSocketFdinfo reads the two ends of a TCP socket from a socket_fdinfo: local, remote, and whether it is an IPv4 or IPv6 TCP socket at all.
func parseSocketFdinfo(b []byte) (local, remote netip.AddrPort, ok bool) {
	if len(b) < sockFdinfoIn+inLAddr+16 {
		return netip.AddrPort{}, netip.AddrPort{}, false
	}
	if kind := binary.LittleEndian.Uint32(b[sockFdinfoKind:]); kind != sockinfoIn && kind != sockinfoTCP {
		return netip.AddrPort{}, netip.AddrPort{}, false
	}
	in := b[sockFdinfoIn:]
	var l, r netip.Addr
	switch in[inVFlag] & (inpIPv4 | inpIPv6) {
	case inpIPv4:
		l, r = netip.AddrFrom4([4]byte(in[inLAddr+12:inLAddr+16])), netip.AddrFrom4([4]byte(in[inFAddr+12:inFAddr+16]))
	case inpIPv6:
		l, r = netip.AddrFrom16([16]byte(in[inLAddr:inLAddr+16])).Unmap(), netip.AddrFrom16([16]byte(in[inFAddr:inFAddr+16])).Unmap()
	default:
		return netip.AddrPort{}, netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(l, binary.BigEndian.Uint16(in[inLPort:])), netip.AddrPortFrom(r, binary.BigEndian.Uint16(in[inFPort:])), true
}
