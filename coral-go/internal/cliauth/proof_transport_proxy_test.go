package cliauth

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7489: the transport the command-line client dials with, when the default one is already wrapped, sends a loopback request through Codex's command proxy while Codex says it is active.
func TestTheClientsOwnTransportUsesCodexsProxyForLoopback(t *testing.T) {
	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })
	http.DefaultTransport = roundTripperFunc(func(*http.Request) (*http.Response, error) { return nil, nil }) // wrapped: baseHTTP builds its own
	t.Setenv("CODEX_NETWORK_PROXY_ACTIVE", "1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:43999")
	tr, ok := baseHTTP().(*http.Transport)
	require.True(t, ok)
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8420/api/x", nil)
	require.NoError(t, err)
	u, err := tr.Proxy(req)
	require.NoError(t, err)
	require.NotNil(t, u)
	assert.Equal(t, "127.0.0.1:43999", u.Host)
	t.Setenv("CODEX_NETWORK_PROXY_ACTIVE", "")
	u, _ = tr.Proxy(req)
	assert.Nil(t, u, "without Codex's marker nothing changes")
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
