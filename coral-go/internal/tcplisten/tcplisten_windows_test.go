//go:build windows

package tcplisten

import (
	"net"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A listener this process opens is in the table with its address, port and this process as owner, in each family, whatever its state field reads.
func TestAListenerIsListedWithItsOwner(t *testing.T) {
	l4, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	listed(t, l4, AFInet, net.IPv4(127, 0, 0, 1))
	l6, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skipf("no IPv6 loopback here: %v", err)
	}
	listed(t, l6, AFInet6, net.IPv6loopback)
}

// listed checks l's row in the table of family af, then closes l.
func listed(t *testing.T, l net.Listener, af uint32, ip net.IP) {
	t.Helper()
	port := l.Addr().(*net.TCPAddr).Port
	rows, err := Rows(af)
	l.Close()
	require.NoError(t, err)
	var found []Row
	for _, r := range rows {
		if r.Port == port {
			found = append(found, r)
		}
	}
	require.Len(t, found, 1, "the listener on %d", port)
	assert.True(t, found[0].Addr.Equal(ip), "its address, not %v", found[0].Addr)
	assert.Equal(t, uint32(os.Getpid()), found[0].PID, "owned by this process")
}

func TestAnotherFamilyIsRefused(t *testing.T) {
	_, err := Rows(17)
	assert.Error(t, err)
}
