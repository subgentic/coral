//go:build windows

package opencode

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/tcplisten"
)

// withRows makes the listener table these rows, per family, for one test.
func withRows(t *testing.T, v4, v6 []tcplisten.Row) {
	t.Helper()
	old := listenerRows
	t.Cleanup(func() { listenerRows = old })
	listenerRows = func(af uint32) ([]tcplisten.Row, error) {
		if af == tcplisten.AFInet6 {
			return v6, nil
		}
		return v4, nil
	}
}

const childPID, port = 4242, 51515

func TestTheChildAloneOnItsPortIsOwned(t *testing.T) {
	withRows(t, []tcplisten.Row{{Addr: net.IPv4(127, 0, 0, 1).To4(), Port: port, PID: childPID}, {Addr: net.IPv4zero.To4(), Port: port + 1, PID: 7}}, nil)
	owned, err := listenerIsChild(context.Background(), port, childPID)
	require.NoError(t, err)
	assert.True(t, owned, "another port's listener does not count")
}

// A row whose owner the table could not name (pid 0) is never the child: the check refuses.
func TestAListenerWithNoOwnerIsRefused(t *testing.T) {
	withRows(t, []tcplisten.Row{{Addr: net.IPv4(127, 0, 0, 1).To4(), Port: port, PID: 0}}, nil)
	owned, err := listenerIsChild(context.Background(), port, childPID)
	require.NoError(t, err)
	assert.False(t, owned)
	withRows(t, []tcplisten.Row{{Addr: net.IPv4(127, 0, 0, 1).To4(), Port: port, PID: childPID}}, []tcplisten.Row{{Addr: net.IPv6loopback, Port: port, PID: 0}})
	owned, err = listenerIsChild(context.Background(), port, childPID)
	require.NoError(t, err)
	assert.False(t, owned, "the child's row does not make an unnamed one on the same port ours")
}

// Another process on every address of the same port, beside the child's own row, in either family: refused.
func TestAnotherProcessOnTheSamePortOnAnyAddressIsRefused(t *testing.T) {
	child := tcplisten.Row{Addr: net.IPv4(127, 0, 0, 1).To4(), Port: port, PID: childPID}
	for name, rows := range map[string][2][]tcplisten.Row{
		"0.0.0.0": {{child, {Addr: net.IPv4zero.To4(), Port: port, PID: 7}}, nil},
		"::":      {{child}, {{Addr: net.IPv6unspecified, Port: port, PID: 7}}},
	} {
		withRows(t, rows[0], rows[1])
		owned, err := listenerIsChild(context.Background(), port, childPID)
		require.NoError(t, err, name)
		assert.False(t, owned, name)
	}
}
