package server

import (
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/pkg/tunnel"
	"testing"
)

func TestTrustProbeNeverRemoteOrOwnerStamped(t *testing.T) {
	path := "/api/filesystem/trust-probe"
	require.Equal(t, tunnel.TierNever, tunnel.Classify("GET", path, "path=%2FUsers%2Fperson%2FCode%2Fproject"))
	_, mode := tunnel.OwnerRoute("GET", path)
	require.False(t, mode.Stamped(), "even a Hub owner cannot probe local project configuration")
}
