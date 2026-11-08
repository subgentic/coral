//go:build windows

package peercred

import (
	"net"
	"net/netip"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestTheTCPTableShowsANewLoopbackListenerAndItsAcceptedConnection is a probe, not a guard, and runs only with CORAL_TCP_TABLE_PROBE set (the number of
// rounds, for example 50), or 50 rounds on a GitHub Actions runner (GITHUB_ACTIONS=true). On one Windows machine the system's TCP table showed a new listener's LISTEN row in only 3 of 20 reads and the server side of
// an accepted loopback connection in 15 of 20 (#540): Coral's peer and listener checks read that table. Each round listens on 127.0.0.1:0, connects to it,
// waits a moment and reads the IPv4 table once (GetExtendedTcpTable, as the checks do), then logs how often each row was there. It fails nothing.
func TestTheTCPTableShowsANewLoopbackListenerAndItsAcceptedConnection(t *testing.T) {
	rounds, err := strconv.Atoi(os.Getenv("CORAL_TCP_TABLE_PROBE"))
	if (err != nil || rounds < 1) && os.Getenv("GITHUB_ACTIONS") == "true" {
		rounds, err = 50, nil // on a CI runner it runs by itself, so one run there answers build or machine (#540)
	}
	if err != nil || rounds < 1 {
		t.Skip("a probe: set CORAL_TCP_TABLE_PROBE to a number of rounds to run it")
	}
	me := uint32(os.Getpid())
	var listen, serverSide, clientSide, wrongState, rowsTotal int
	for i := 0; i < rounds; i++ {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		accepted := make(chan net.Conn, 1)
		go func() {
			c, err := ln.Accept()
			if err == nil {
				accepted <- c
			}
		}()
		c, err := net.Dial("tcp4", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		s := <-accepted
		time.Sleep(200 * time.Millisecond)
		server := netip.MustParseAddrPort(ln.Addr().String())
		client := netip.MustParseAddrPort(c.LocalAddr().String())
		b, err := tcpTable(2) // AF_INET
		if err != nil {
			t.Fatal(err)
		}
		rows, err := parseTCPTable(b, false)
		if err != nil {
			t.Fatal(err)
		}
		rowsTotal += len(rows)
		for _, r := range rows {
			if r.pid != me {
				continue
			}
			switch {
			case r.local == server && r.state == 2: // LISTEN
				listen++
			case r.local == server && r.remote == client:
				if r.state == 5 { // ESTABLISHED
					serverSide++
				} else {
					wrongState++
				}
			case r.local == client && r.remote == server:
				if r.state == 5 {
					clientSide++
				} else {
					wrongState++
				}
			}
		}
		c.Close()
		s.Close()
		ln.Close()
	}
	t.Logf("TCP table probe, %d rounds: LISTEN row %d, server-side ESTABLISHED row %d, client-side ESTABLISHED row %d, rows of ours in another state %d, table rows on average %d",
		rounds, listen, serverSide, clientSide, wrongState, rowsTotal/rounds)
}
