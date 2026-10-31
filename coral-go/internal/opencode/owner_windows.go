//go:build windows

package opencode

import (
	"github.com/subgentic/coral/internal/tcplisten"
)

// listenerRows is the system's listener table of one address family; a test replaces it.
var listenerRows = tcplisten.Rows

// systemListenerPIDs are the processes listening on TCP port on any address, IPv4 and IPv6, from the system's listener table. Not from netstat: it picks
// listeners out by their state, which on some Windows builds reads wrong, and then it shows none (internal/tcplisten).
func systemListenerPIDs(port int) ([]int, error) {
	var pids []int
	seen := map[uint32]bool{}
	for _, af := range []uint32{tcplisten.AFInet, tcplisten.AFInet6} {
		rows, err := listenerRows(af)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			if r.Port == port && !seen[r.PID] { // a pid of 0 (an owner the table could not name) is kept: it is never the child, so the check refuses
				seen[r.PID] = true
				pids = append(pids, int(r.PID))
			}
		}
	}
	return pids, nil
}
