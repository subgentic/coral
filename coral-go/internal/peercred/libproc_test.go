package peercred

import (
	"encoding/binary"
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// sockFdinfo builds a socket_fdinfo's bytes: the kind, then the in_sockinfo with its ports (network order), flag and the two addresses.
func sockFdinfo(kind uint32, vflag byte, local, remote netip.AddrPort) []byte {
	b := make([]byte, sockFdinfoSize)
	binary.LittleEndian.PutUint32(b[sockFdinfoKind:], kind)
	in := b[sockFdinfoIn:]
	binary.BigEndian.PutUint16(in[inLPort:], local.Port())
	binary.BigEndian.PutUint16(in[inFPort:], remote.Port())
	in[inVFlag] = vflag
	put := func(at int, a netip.Addr) {
		if vflag == inpIPv4 {
			x := a.As4()
			copy(in[at+12:], x[:])
		} else {
			x := a.As16()
			copy(in[at:], x[:])
		}
	}
	put(inLAddr, local.Addr())
	put(inFAddr, remote.Addr())
	return b
}

// #12542: the two ends of a socket as libproc describes it, for the macOS check that a signed process falls back on when the kernel's socket table hides the client's.
func TestParseSocketFdinfo(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.1:58084")
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	l, r, ok := parseSocketFdinfo(sockFdinfo(sockinfoTCP, inpIPv4, client, server))
	require.True(t, ok)
	assert.Equal(t, client, l)
	assert.Equal(t, server, r)

	client6, server6 := netip.MustParseAddrPort("[::1]:58084"), netip.MustParseAddrPort("[::1]:8420")
	l, r, ok = parseSocketFdinfo(sockFdinfo(sockinfoTCP, inpIPv6, client6, server6))
	require.True(t, ok)
	assert.Equal(t, client6, l)
	assert.Equal(t, server6, r)

	mapped := func(ap netip.AddrPort) netip.AddrPort {
		return netip.AddrPortFrom(netip.AddrFrom16(ap.Addr().As16()), ap.Port())
	}
	l, _, ok = parseSocketFdinfo(sockFdinfo(sockinfoTCP, inpIPv6, netip.AddrPortFrom(netip.MustParseAddr("::ffff:127.0.0.1"), 58084), mapped(server)))
	require.True(t, ok)
	assert.Equal(t, client, l, "an IPv4-mapped address is the IPv4 one")

	for name, b := range map[string][]byte{
		"a unix socket":     sockFdinfo(1+sockinfoTCP, inpIPv4, client, server),
		"neither family":    sockFdinfo(sockinfoTCP, 0, client, server),
		"a short buffer":    make([]byte, 100),
		"no buffer at all":  nil,
		"both families set": sockFdinfo(sockinfoTCP, inpIPv4|inpIPv6, client, server),
	} {
		_, _, ok := parseSocketFdinfo(b)
		assert.False(t, ok, name)
	}
}
