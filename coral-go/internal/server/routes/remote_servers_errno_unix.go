//go:build !windows

package routes

import (
	"errors"
	"syscall"
)

// The socket errors a failed health probe is told apart by (probeFailure). Windows reports its own Winsock codes, which
// are not syscall's: see remote_servers_errno_windows.go (#18497).
func probeRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }
func probeNetUnreachable(err error) bool {
	return errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH)
}
func probeReset(err error) bool { return errors.Is(err, syscall.ECONNRESET) }
