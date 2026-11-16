//go:build windows

package routes

import (
	"errors"

	"golang.org/x/sys/windows"
)

// The socket errors a failed health probe is told apart by (probeFailure). On Windows a dial fails with a Winsock code
// (WSAECONNREFUSED 10061 and the like), which errors.Is does not match to syscall.ECONNREFUSED: the person saw "remote
// unreachable" for a server that refused the connection (#18497).
func probeRefused(err error) bool { return errors.Is(err, windows.WSAECONNREFUSED) }
func probeNetUnreachable(err error) bool {
	return errors.Is(err, windows.WSAENETUNREACH) || errors.Is(err, windows.WSAEHOSTUNREACH)
}
func probeReset(err error) bool { return errors.Is(err, windows.WSAECONNRESET) }
