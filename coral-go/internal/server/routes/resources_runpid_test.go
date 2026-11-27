package routes

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21803: a run_pid is believed only from this computer: not from another address, and never from a claim the Hub's tunnel carried (its pid is the remote machine's).
func TestARunPIDIsBelievedOnlyFromThisComputerNotThroughTheTunnel(t *testing.T) {
	local := httptest.NewRequest("POST", "/api/resources/x/claim", nil)
	local.RemoteAddr = "127.0.0.1:5000"
	assert.Equal(t, 4242, localRunPID(local, 4242))

	tunnelled := httptest.NewRequest("POST", "/api/resources/x/claim", nil)
	tunnelled.RemoteAddr = "127.0.0.1:5000"
	tunnelled.Header.Set(tunnel.ViaHeader, "hub")
	assert.Equal(t, 0, localRunPID(tunnelled, 4242), "through the tunnel")

	remote := httptest.NewRequest("POST", "/api/resources/x/claim", nil)
	remote.RemoteAddr = "203.0.113.7:5000"
	assert.Equal(t, 0, localRunPID(remote, 4242), "from another address")
}
