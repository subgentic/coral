//go:build darwin

package peercred

import (
	"errors"
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
	for i := 0; i < maxScanWaiters; i++ { // as many callers at once as the queue holds, all for a socket that exists
		wg.Add(1)
		go func() {
			defer wg.Done()
			mine, err := ownedByMyProcess(first, server)
			assert.NoError(t, err)
			assert.True(t, mine)
		}()
	}
	wg.Wait()
	assert.Equal(t, int32(1), scans.Load(), "%d callers for one socket: one scan", maxScanWaiters)

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
			assert.True(t, errors.Is(err, ErrLayout) || errors.Is(err, errScanBusy), "no socket of this connection seen: the layout answer, or refused at once when the queue is full (%v)", err)
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

// #12546 (Security): a local flood of misses cannot queue the owner's own sign-in. Callers past the queue's bound are answered at once as unattributed (a refusal, never the layout answer),
// and callers inside it still get their turn.
func TestCallersPastTheScanQueueAreRefusedAtOnceAndTheRestStillGetTheirTurn(t *testing.T) {
	real, gap := mySockets, scanGap
	defer func() { mySockets, scanGap = real, gap; forgetScan() }()
	scanGap = time.Millisecond
	forgetScan()
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	release := make(chan struct{})
	var releaseOnce sync.Once
	closeRelease := func() { releaseOnce.Do(func() { close(release) }) }
	defer closeRelease() // runs before the restore above: a scan left blocked would hold the lock that restore needs
	entered := make(chan struct{}, 64)
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
		entered <- struct{}{}
		<-release
		visit(server, netip.MustParseAddrPort("127.0.0.1:50000"))
		return nil
	}
	results := make(chan error, 64)
	ask := func(port int) {
		_, err := ownedByMyProcess(netip.MustParseAddrPort("127.0.0.1:"+strconv.Itoa(port)), server)
		results <- err
	}
	go ask(50000) // the one scanning
	<-entered
	for i := 1; i < maxScanWaiters; i++ { // fills the queue
		go ask(50000 + i)
	}
	require.Eventually(t, func() bool { return int(scanWaiting.Load()) == maxScanWaiters }, 5*time.Second, time.Millisecond)

	// the next callers are past the bound: answered at once, not as the layout answer
	for i := 0; i < 5; i++ {
		go ask(60000 + i)
	}
	for i := 0; i < 5; i++ {
		select {
		case err := <-results:
			assert.ErrorIs(t, err, errScanBusy)
			assert.NotErrorIs(t, err, ErrLayout)
			assert.NotErrorIs(t, err, ErrNotFound)
		case <-time.After(5 * time.Second):
			t.Fatal("a caller past the bound waited instead of being refused")
		}
	}
	closeRelease() // the queue drains: every caller inside the bound gets an answer
	for i := 0; i < maxScanWaiters; i++ {
		select {
		case err := <-results:
			assert.NotErrorIs(t, err, errScanBusy, "a caller inside the bound is answered by a scan, not refused")
		case <-time.After(10 * time.Second):
			t.Fatal("a caller inside the bound never got its turn")
		}
	}
}

// The gap is 100 ms (QA): two asks 10 ms apart share one scan, and an ask 150 ms after the scan makes a new one. The default gap is used, not a test value.
func TestTwoAsksTenMillisecondsApartShareAScanAndOneAfterTheGapDoesNot(t *testing.T) {
	real := mySockets
	defer func() { mySockets = real; forgetScan() }()
	forgetScan()
	require.Equal(t, 100*time.Millisecond, scanGap, "the gap this test is about")
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	client := netip.MustParseAddrPort("127.0.0.1:50001")
	var scans atomic.Int32
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
		scans.Add(1)
		visit(client, server)
		visit(server, client)
		return nil
	}
	ask := func() {
		mine, err := ownedByMyProcess(client, server)
		require.NoError(t, err)
		require.True(t, mine)
	}
	ask()
	time.Sleep(10 * time.Millisecond) // sleep-ok: the gap itself is what is measured
	ask()
	assert.Equal(t, int32(1), scans.Load(), "10 ms apart: one scan")
	time.Sleep(150*time.Millisecond - 10*time.Millisecond) // sleep-ok: 150 ms after the first scan
	ask()
	assert.Equal(t, int32(2), scans.Load(), "150 ms after the scan: a new one")
}
