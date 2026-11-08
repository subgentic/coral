//go:build windows

package hooks

import (
	"errors"
	"net"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

// The listener table can miss a listener that is really there (on Windows it showed a new one's row about three times in twenty). Then a missing row is not "nothing is there": the connection is made, and the owner
// of its server end is checked like a listener's. A real loopback listener is here; the table is a stub that shows no listener row.
func blindRig(t *testing.T, rows func(clientPort int) []connRow, owner func(uint32) (*windows.SID, string, error)) (host string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })
	port = ln.Addr().(*net.TCPAddr).Port
	clients := make(chan int, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			clients <- c.RemoteAddr().(*net.TCPAddr).Port
			t.Cleanup(func() { _ = c.Close() })
		}
	}()
	resetListenerCheck(t, func(string, int) ([]uint32, error) { return nil, nil }, owner) // the listener table shows nothing
	prevConn, prevRows, prevWin, prevRetry, prevGap := connectionOwnerPID, tcpConns, connReadWindow, connRetryWindow, connReadGap
	connectionOwnerPID = connectionOwner
	connReadWindow, connRetryWindow, connReadGap = 600*time.Millisecond, 300*time.Millisecond, 50*time.Millisecond
	client := 0
	tcpConns = func(uint32) ([]connRow, error) {
		// the newest connection's client port: a retry dials a fresh connection (until its port arrives, the table shows the last)
		for drained := false; !drained; {
			select {
			case client = <-clients:
			default:
				drained = true
			}
		}
		if client == 0 {
			select {
			case client = <-clients:
			case <-time.After(time.Second):
			}
		}
		return rows(client), nil
	}
	t.Cleanup(func() {
		connectionOwnerPID, tcpConns, connReadWindow, connRetryWindow, connReadGap = prevConn, prevRows, prevWin, prevRetry, prevGap
	})
	return "127.0.0.1", port
}

func serverEnd(port, client int, pid uint32) connRow {
	lo := net.IPv4(127, 0, 0, 1).To4()
	return connRow{lAddr: lo, lPort: port, rAddr: lo, rPort: client, state: tcpStateEstablished, pid: pid}
}

func TestAListenerRowTheTableMissesDoesNotMeanNothingIsThere(t *testing.T) {
	// no row for the connection at all: the owner is not known, so the token is not sent
	host, port := blindRig(t, func(int) []connRow { return nil }, func(uint32) (*windows.SID, string, error) { return nil, "", errors.New("unused") })
	start := time.Now()
	err := checkListener(host, port)
	var fe *ForeignListenerError
	require.ErrorAs(t, err, &fe, "refused: %v", err)
	assert.Equal(t, port, fe.Port)
	assert.Less(t, time.Since(start), 3*time.Second, "the re-reading is bounded")
	assert.GreaterOrEqual(t, time.Since(start), 500*time.Millisecond, "after the window")
}

func TestTheOwnerOfTheAcceptedConnectionIsCheckedLikeAListener(t *testing.T) {
	stranger := func(uint32) (*windows.SID, string, error) { return mySID(t), `C:\tools\stranger.exe`, nil } // this account, so the image is what is refused
	var port int
	// a row naming another pid whose image is not Coral's: refused, with the image's wording
	host, p := blindRig(t, func(client int) []connRow { return []connRow{serverEnd(port, client, 4321)} }, stranger)
	port = p
	err := checkListener(host, port)
	var fe *ForeignListenerError
	require.ErrorAs(t, err, &fe, "%v", err)
	assert.Equal(t, uint32(4321), fe.PID)
	assert.Contains(t, fe.Why, "stranger.exe")
}

func TestTheAcceptedConnectionOfThisVeryProcessPassesAndTwoRowsRefuse(t *testing.T) {
	var port int
	host, p := blindRig(t, func(client int) []connRow { return []connRow{serverEnd(port, client, uint32(os.Getpid()))} },
		func(uint32) (*windows.SID, string, error) { return nil, "", errors.New("unused") })
	port = p
	assert.NoError(t, checkListener(host, port), "a test's own in-process server passes (tests only), as a listener row would")

	var port2 int
	host2, p2 := blindRig(t, func(client int) []connRow {
		return []connRow{serverEnd(port2, client, 11), serverEnd(port2, client, 12)}
	}, func(uint32) (*windows.SID, string, error) { return nil, "", errors.New("unused") })
	port2 = p2
	require.Error(t, checkListener(host2, port2), "two owners for one connection: refused")
}

// The table shows a listener row that passes (this very process, in a test), but the connection made to the port is accepted by another program: the check refuses. A program on 127.0.0.1:<port>
// takes the connections while Coral holds 0.0.0.0:<port>, and the table can miss its listener row.
func TestListenerRowsThatPassDoNotHideAnotherProgramThatAcceptsTheConnection(t *testing.T) {
	stranger := func(uint32) (*windows.SID, string, error) { return mySID(t), `C:\tools\stranger.exe`, nil } // this account, so the image is what is refused
	var port int
	host, p := blindRig(t, func(client int) []connRow { return []connRow{serverEnd(port, client, 4321)} }, stranger)
	port = p
	listenerPIDs = func(string, int) ([]uint32, error) { return []uint32{uint32(os.Getpid())}, nil } // the row the table shows is this process's, which passes in tests
	err := checkListener(host, port)
	var fe *ForeignListenerError
	require.ErrorAs(t, err, &fe, "%v", err)
	assert.Equal(t, uint32(4321), fe.PID, "the connection's owner is the one refused")
	assert.Contains(t, fe.Why, "stranger.exe")
}

// mySID is this process's own account, for an owner stub whose account passes.
func mySID(t *testing.T) *windows.SID {
	t.Helper()
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	require.NoError(t, err)
	return u.User.Sid
}

// The table misses the first connection's row for its whole window but shows the second one's: the one retry on a fresh connection finds it, and the owner is checked as usual (this process passes).
func TestARowMissedOnTheFirstConnectionIsFoundOnTheRetry(t *testing.T) {
	var port int
	first := 0
	host, p := blindRig(t, func(client int) []connRow {
		if first == 0 {
			first = client
		}
		if client == first {
			return nil // the first connection's row never shows
		}
		return []connRow{serverEnd(port, client, uint32(os.Getpid()))}
	}, func(uint32) (*windows.SID, string, error) { return nil, "", errors.New("unused") })
	port = p
	start := time.Now()
	assert.NoError(t, checkListener(host, port), "found on the second connection")
	assert.GreaterOrEqual(t, time.Since(start), connReadWindow, "the first window ran out first")
}

// A row that never shows on either connection refuses after the two windows, and no sooner.
func TestARowMissedOnEveryTryRefusesAfterBothWindows(t *testing.T) {
	host, port := blindRig(t, func(int) []connRow { return nil }, func(uint32) (*windows.SID, string, error) { return nil, "", errors.New("unused") })
	start := time.Now()
	err := checkListener(host, port)
	var fe *ForeignListenerError
	require.ErrorAs(t, err, &fe, "refused: %v", err)
	took := time.Since(start)
	assert.GreaterOrEqual(t, took, connReadWindow+connRetryWindow, "both windows ran")
	assert.Less(t, took, connReadWindow+connRetryWindow+2*time.Second, "and that is the bound")
}
