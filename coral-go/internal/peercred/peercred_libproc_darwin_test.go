//go:build darwin

package peercred

import (
	"net"
	"net/netip"
	"os"
	"os/exec"
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
	defer func() { (<-accepted).Close() }()
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
	defer func() { mySockets = real }()
	mySockets = func(visit func(local, remote netip.AddrPort) bool) error {
		visit(server, client) // only the server's own end is this user's
		return nil
	}
	_, err = ownedByMyProcess(client, server)
	assert.ErrorIs(t, err, ErrNotFound, "no socket of this user's has the client's ends")
	assert.NotErrorIs(t, err, ErrLayout)

	// nothing of the connection seen at all, not even the server's end: libproc did not show the sockets
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
