package opencode

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The check that needs no listener row: connect to 127.0.0.1:<port> now, and read the table for the row of the SERVER end of that very connection (local end 127.0.0.1:<port>, remote end our own client
// port). Its process must be the child or one of its descendants. The row is read again for a bounded time because the table can be late: a handful of reads in about two seconds. A row that never appears,
// a row with another process, or two rows refuse; the caller sends the password only on a yes.
var (
	connReadWindow = 2 * time.Second
	connReadGap    = 200 * time.Millisecond
	// isDescendantOf is isDescendant, a variable so a test can name the process a row belongs to.
	isDescendantOf = isDescendant
)

// connectionOwnerIsChild reports whether the process owning the server end of a connection made to the port now is child or its descendant. Nothing listening (the connection is refused) is false with no error.
// Where the system's table is not read this way (not Windows), it is false with no error: the listener rows are the check there.
func connectionOwnerIsChild(ctx context.Context, port, child int) (bool, error) {
	if runtime.GOOS != "windows" {
		return false, nil
	}
	d := net.Dialer{Timeout: time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false, nil // nothing accepted: nobody listens
	}
	defer conn.Close()
	ta, ok := conn.LocalAddr().(*net.TCPAddr)
	if !ok {
		return false, errors.New("the connection's own port is not known")
	}
	deadline := time.Now().Add(connReadWindow)
	for {
		out, rerr := netstatTable(ctx)
		if rerr != nil {
			return false, rerr
		}
		pids := serverEndPIDs(out, port, ta.Port)
		switch {
		case len(pids) == 1:
			return isDescendantOf(ctx, pids[0], child), nil
		case len(pids) > 1:
			return false, nil // two rows: not one process's connection
		}
		if time.Now().After(deadline) {
			return false, errors.New("the system's table never showed who owns the server end of the connection")
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(connReadGap):
		}
	}
}

// serverEndPIDs are the pids of the rows "TCP 127.0.0.1:<port> 127.0.0.1:<clientPort> ESTABLISHED <pid>" in a netstat table: the server end of the connection from clientPort to port.
func serverEndPIDs(out []byte, port, clientPort int) []int {
	var pids []int
	local, remote := "127.0.0.1:"+strconv.Itoa(port), "127.0.0.1:"+strconv.Itoa(clientPort)
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 5 && strings.EqualFold(f[0], "TCP") && f[1] == local && f[2] == remote && strings.EqualFold(f[3], "ESTABLISHED") {
			if n, err := strconv.Atoi(f[4]); err == nil && n > 0 {
				pids = append(pids, n)
			}
		}
	}
	return pids
}
