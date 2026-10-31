// Package tcplisten reads which processes listen on which TCP ports, from the system's own table (Windows: GetExtendedTcpTable). The hooks' check of who
// would receive a connection and opencode's check that the listener is the server Coral started both ask it.
//
// Rows are asked for by class (listeners only), never picked out by their state: on Windows 11 build 26300 a listener's state field reads 0, 1, 2 or 6
// at random, so netstat and Get-NetTCPConnection, which go by the state, do not show a listener that is there (measured 2026-10-31), while the
// listener class still lists it, with its owner.
package tcplisten

import "net"

// The address families Rows takes.
const (
	AFInet  = 2  // AF_INET
	AFInet6 = 23 // AF_INET6
)

// Row is one listening socket: its address (0.0.0.0 or :: for every address), port and owning process.
type Row struct {
	Addr net.IP
	Port int
	PID  uint32
}
