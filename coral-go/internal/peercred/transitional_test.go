package peercred

import (
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #385 (b): the rule for a client row Windows reports in a transitional state. One case per condition; dropping any one condition from ownerPIDTransitional fails the case named for it.
func TestOwnerPIDTransitionalOneCasePerCondition(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.1:50000")
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	other := netip.MustParseAddrPort("127.0.0.1:50001")
	row := func(local, remote netip.AddrPort, state, pid uint32) tcpRow {
		return tcpRow{local: local, remote: remote, state: state, pid: pid}
	}
	for _, tc := range []struct {
		name  string
		rows  []tcpRow
		pid   uint32
		state uint32
		err   error
	}{
		{"LISTEN row with this pair and a pid", []tcpRow{row(client, server, mibListen, 77)}, 77, mibListen, nil},
		{"CLOSED row with this pair and a pid", []tcpRow{row(client, server, mibClosed, 78)}, 78, mibClosed, nil},
		{"state 0 row with this pair and a pid", []tcpRow{row(client, server, 0, 79)}, 79, 0, nil},
		{"condition: the exact pair (another client port)", []tcpRow{row(other, server, mibListen, 77)}, 0, 0, ErrNotFound},
		{"condition: the exact pair (another server port)", []tcpRow{row(client, netip.MustParseAddrPort("127.0.0.1:9999"), mibListen, 77)}, 0, 0, ErrNotFound},
		{"condition: a real listener has no remote, so it never matches the pair", []tcpRow{row(server, netip.AddrPort{}, mibListen, 77)}, 0, 0, ErrNotFound},
		{"condition: pid != 0 (a row nobody owns)", []tcpRow{row(client, server, mibListen, 0)}, 0, 0, ErrNotFound},
		{"condition: only the transitional states (ESTABLISHED is ownerPID's)", []tcpRow{row(client, server, 5, 77)}, 0, 0, ErrNotFound},
		{"condition: only the transitional states (TIME_WAIT)", []tcpRow{row(client, server, mibTimeWait, 77)}, 0, 0, ErrNotFound},
		{"condition: only the transitional states (DELETE_TCB)", []tcpRow{row(client, server, mibDeleteTCB, 77)}, 0, 0, ErrNotFound},
		{"condition: no other pid on the pair (ambiguous: fail closed)", []tcpRow{row(client, server, mibListen, 77), row(client, server, mibClosed, 88)}, 0, 0, errAmbiguous},
		{"the same pid twice is one owner", []tcpRow{row(client, server, mibListen, 77), row(client, server, mibClosed, 77)}, 77, mibClosed, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pid, state, err := ownerPIDTransitional(tc.rows, client, server)
			assert.Equal(t, tc.err, err)
			assert.Equal(t, tc.pid, pid)
			assert.Equal(t, tc.state, state)
		})
	}
}

// The transitional rule is a Windows one: ownerPID (the live-row rule every platform's table reader uses) still skips them, so nothing about a CLOSED or LISTEN row changed there.
func TestOwnerPIDStillSkipsTransitionalRows(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.1:50000")
	server := netip.MustParseAddrPort("127.0.0.1:8420")
	for _, st := range []uint32{mibClosed, mibListen, mibTimeWait, mibDeleteTCB} {
		_, err := ownerPID([]tcpRow{{local: client, remote: server, state: st, pid: 77}}, client, server)
		assert.ErrorIs(t, err, ErrNotFound, "state %d", st)
	}
	pid, err := ownerPID([]tcpRow{{local: client, remote: server, state: 5, pid: 77}}, client, server)
	assert.NoError(t, err)
	assert.Equal(t, uint32(77), pid)
}
