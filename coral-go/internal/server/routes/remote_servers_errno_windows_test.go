//go:build windows

package routes

import (
	"net"
	"os"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"golang.org/x/sys/windows"
)

// #18497: a dial that fails on Windows carries a Winsock code; the person is told the cause, not "remote unreachable".
func TestProbeFailureNamesTheCauseOfAWinsockError(t *testing.T) {
	for name, tc := range map[string]struct {
		errno syscall.Errno
		want  string
	}{
		"refused":          {windows.WSAECONNREFUSED, "remote refused the connection"},
		"network":          {windows.WSAENETUNREACH, "remote network or host is unreachable"},
		"host unreachable": {windows.WSAEHOSTUNREACH, "remote network or host is unreachable"},
		"reset":            {windows.WSAECONNRESET, "remote closed the connection"},
	} {
		err := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connectex", tc.errno)}
		assert.Contains(t, probeFailure(err), tc.want, name)
	}
}
