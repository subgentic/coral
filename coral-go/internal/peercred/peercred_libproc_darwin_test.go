//go:build darwin

package peercred

import (
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12542: libproc finds the client's socket among this user's processes with a real loopback connection, and does not find one that is not there. The kernel's socket table is not read here:
// this is the path a signed process takes when that table hides the client's socket.
func TestOwnedByMyProcessFindsARealClientSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() { c, _ := ln.Accept(); accepted <- c }()
	c, err := net.Dial("tcp", ln.Addr().String())
	require.NoError(t, err)
	defer c.Close()
	srv := <-accepted // the server's end is a descriptor of this process only once Accept has returned
	require.NotNil(t, srv)
	defer srv.Close()
	client := c.LocalAddr().(*net.TCPAddr).AddrPort()
	server := c.RemoteAddr().(*net.TCPAddr).AddrPort()

	mine, err := ownedByMyProcess(client, server)
	require.NoError(t, err)
	assert.True(t, mine)

	// the ends the wrong way round are the server's own socket, which is not the client's row
	_, err = ownedByMyProcess(server, client)
	assert.NoError(t, err, "the server's end is this process's socket too: it is found, as the ends it has")

	// the server's own end seen but not the client's: another user's (or nobody's) client, refused as before
	real := mySockets
	defer func() { mySockets = real; forgetScan() }()
	forgetScan()
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
		visit(server, client) // only the server's own end is this user's
		return nil
	}
	_, err = ownedByMyProcess(client, server)
	assert.ErrorIs(t, err, ErrNotFound, "no socket of this user's has the client's ends")
	assert.NotErrorIs(t, err, ErrLayout)

	// nothing of the connection seen at all, not even the server's end: libproc did not show the sockets
	forgetScan()
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error { return nil }
	_, err = ownedByMyProcess(client, server)
	assert.ErrorIs(t, err, ErrLayout)
}

// #12529, #12542: a client in ANOTHER process, which is how every request reaches Coral. The kernel's table shows a process signed the usual way only its own sockets, so the owner of
// this client was never found there and every sign-in was refused; the owner check now finds it through libproc. Run as a binary signed with `codesign --force --sign -` (the way a release
// is signed, unlike the Go linker's own signature) this test fails without the libproc lookup; as a plain `go test` it passes either way.
func TestOwnerIsMeForAClientInAnotherProcess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	nc, err := exec.LookPath("nc")
	if err != nil {
		t.Skip("no nc to be a client in another process")
	}
	cmd := exec.Command(nc, "127.0.0.1", ln.Addr().(*net.TCPAddr).AddrPort().String()[len("127.0.0.1:"):])
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	defer func() { stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	conn, err := ln.Accept()
	require.NoError(t, err)
	defer conn.Close()
	client := conn.RemoteAddr().(*net.TCPAddr).AddrPort()
	server := conn.LocalAddr().(*net.TCPAddr).AddrPort()
	require.NotEqual(t, os.Getpid(), cmd.Process.Pid)

	mine, err := ownerIsMe(client, server, time.Time{})
	require.NoError(t, err, "the client's socket is found whoever signed this binary")
	assert.True(t, mine, "a client of this user's in another process is this user's")
}

// forgetScan drops the shared snapshot, for a test that changes what a scan shows.
func forgetScan() {
	scanMu.Lock()
	scanSeen = nil
	scanMu.Unlock()
}

// #12542 (Security SHOULD 4): asking often costs a wait, never a pile of scans. Many connections asking at once share scans, at most one per gap; a connection made after the last scan is found
// by the next one (a miss waits out the gap and scans again) and not refused.
func TestScansAreBoundedAndSharedAndANewConnectionIsStillFound(t *testing.T) {
	real, gap := mySockets, scanGap
	defer func() { mySockets, scanGap = real, gap; forgetScan() }()
	scanGap = 60 * time.Millisecond
	forgetScan()
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	var scans atomic.Int32
	var live sync.Map // client addr -> bool: the sockets that exist now
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
		scans.Add(1)
		live.Range(func(k, _ any) bool {
			c := k.(netip.AddrPort)
			return !visit(c, server) && !visit(server, c) // both ends, as the table has them
		})
		return nil
	}
	first := netip.MustParseAddrPort("127.0.0.1:50001")
	live.Store(first, true)

	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ { // 40 callers at once, all for a socket that exists
		wg.Add(1)
		go func() {
			defer wg.Done()
			mine, err := ownedByMyProcess(first, server)
			assert.NoError(t, err)
			assert.True(t, mine)
		}()
	}
	wg.Wait()
	assert.Equal(t, int32(1), scans.Load(), "40 callers for one socket: one scan")

	// a connection made after that scan: found, by waiting out the gap and scanning once more
	second := netip.MustParseAddrPort("127.0.0.1:50002")
	live.Store(second, true)
	mine, err := ownedByMyProcess(second, server)
	require.NoError(t, err)
	assert.True(t, mine, "a connection newer than the last scan is not refused")
	assert.Equal(t, int32(2), scans.Load())

	// a flood of callers for sockets that are not there: bounded by the gap, not by how many ask
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(port int) {
			defer wg.Done()
			_, err := ownedByMyProcess(netip.MustParseAddrPort("127.0.0.1:"+strconv.Itoa(port)), server)
			assert.ErrorIs(t, err, ErrLayout, "no socket of this connection seen: the layout answer")
		}(60000 + i)
	}
	wg.Wait()
	elapsed := time.Since(start)
	assert.LessOrEqual(t, int(scans.Load()), 2+int(elapsed/scanGap)+1, "scans are at most one per gap however many ask (%d scans in %v)", scans.Load(), elapsed)
}

// Both ends must match: a socket of this user's whose local end is the client's but whose remote end is another address (the client's connection to somewhere else, or a reused port) is not the
// client's connection to this server, and neither is one with the server's address as its remote and another local end (#12542, Security).
func TestASocketMustHaveBothEndsToBeTheClients(t *testing.T) {
	real := mySockets
	defer func() { mySockets = real; forgetScan() }()
	client := netip.MustParseAddrPort("127.0.0.1:51234")
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	elsewhere := netip.MustParseAddrPort("127.0.0.1:9999")
	for name, shown := range map[string][][2]netip.AddrPort{
		"the client's local end to another remote": {{client, elsewhere}, {server, client}},
		"the server as remote from another local":  {{elsewhere, server}, {server, client}},
		"the ends swapped":                         {{server, client}},
	} {
		forgetScan()
		mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
			for _, ends := range shown {
				visit(ends[0], ends[1])
			}
			return nil
		}
		mine, err := ownedByMyProcess(client, server)
		assert.False(t, mine, name)
		assert.ErrorIs(t, err, ErrNotFound, name)
	}
}
