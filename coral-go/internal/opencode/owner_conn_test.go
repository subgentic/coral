package opencode

import (
	"context"
	"fmt"
	"net"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A table that shows no listener row (on Windows it showed a new listener's row about three times in twenty): the owner is read from the row of the server end of a connection made now. The table here is a stub
// that names whatever the test says; the listener and the connection are real, on loopback.
func connOwnerRig(t *testing.T, rows func(port, clientPort int) string) (port int, ln net.Listener) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("the connection-owner check is the Windows path")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })
	port = ln.Addr().(*net.TCPAddr).Port
	clientPorts := make(chan int, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			clientPorts <- c.RemoteAddr().(*net.TCPAddr).Port
			t.Cleanup(func() { _ = c.Close() })
		}
	}()
	oldTable, oldDesc, oldWin, oldGap := netstatTable, isDescendantOf, connReadWindow, connReadGap
	t.Cleanup(func() { netstatTable, isDescendantOf, connReadWindow, connReadGap = oldTable, oldDesc, oldWin, oldGap })
	var client int
	netstatTable = func(ctx context.Context) ([]byte, error) {
		if client == 0 {
			select {
			case client = <-clientPorts:
			case <-time.After(time.Second):
			}
		}
		return []byte(rows(port, client)), nil
	}
	connReadWindow, connReadGap = 600*time.Millisecond, 50*time.Millisecond
	return port, ln
}

func TestAConnectionRowNamingTheChildPassesAndAnotherPidRefuses(t *testing.T) {
	const child, stranger = 4242, 7777
	port, _ := connOwnerRig(t, func(port, client int) string {
		return fmt.Sprintf("  TCP    127.0.0.1:%d    127.0.0.1:%d    ESTABLISHED    %d\n  TCP    127.0.0.1:%d    127.0.0.1:%d    ESTABLISHED    %d\n", port, client, child, client, port, 9999)
	})
	isDescendantOf = func(_ context.Context, pid, c int) bool { return pid == c }
	owned, err := connectionOwnerIsChild(context.Background(), port, child)
	require.NoError(t, err)
	assert.True(t, owned, "the server end of the connection belongs to the child")
	owned, err = connectionOwnerIsChild(context.Background(), port, stranger)
	require.NoError(t, err)
	assert.False(t, owned, "the row names another pid: refused")
}

func TestAConnectionRowThatNeverAppearsOrAppearsTwiceRefuses(t *testing.T) {
	port, _ := connOwnerRig(t, func(port, client int) string { return "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    4\n" })
	isDescendantOf = func(context.Context, int, int) bool { return true }
	start := time.Now()
	owned, err := connectionOwnerIsChild(context.Background(), port, 1)
	assert.False(t, owned)
	require.Error(t, err, "no row: the owner is not known")
	assert.Less(t, time.Since(start), 3*time.Second, "the re-reading is bounded")
	assert.GreaterOrEqual(t, time.Since(start), 500*time.Millisecond, "and it did wait for the window")

	port2, _ := connOwnerRig(t, func(port, client int) string {
		return fmt.Sprintf("  TCP    127.0.0.1:%d    127.0.0.1:%d    ESTABLISHED    11\n  TCP    127.0.0.1:%d    127.0.0.1:%d    ESTABLISHED    12\n", port, client, port, client)
	})
	isDescendantOf = func(context.Context, int, int) bool { return true }
	owned, err = connectionOwnerIsChild(context.Background(), port2, 1)
	require.NoError(t, err)
	assert.False(t, owned, "two rows for the connection: refused")
}

// With no listener row, listenerIsChild asks the connection's owner instead of saying "nobody listens".
func TestWithNoListenerRowTheConnectionDecides(t *testing.T) {
	const child = 4242
	port, _ := connOwnerRig(t, func(port, client int) string {
		return fmt.Sprintf("  TCP    127.0.0.1:%d    127.0.0.1:%d    ESTABLISHED    %d\n", port, client, child) // and no LISTENING row at all
	})
	isDescendantOf = func(_ context.Context, pid, c int) bool { return pid == c }
	owned, err := listenerIsChild(context.Background(), port, child)
	require.NoError(t, err)
	assert.True(t, owned)
	owned, err = listenerIsChild(context.Background(), port, child+1)
	require.NoError(t, err)
	assert.False(t, owned)
}
