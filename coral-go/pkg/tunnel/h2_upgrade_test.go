package tunnel_test

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14534 (coral-hub's question, Security's answer on #14529): turning HTTP/2 on at the Hub's load balancer must not move the tunnel's WebSocket upgrade onto HTTP/2. The hub client Coral dials with
// (cloud.NewHubHTTPClient, through tunnel.Dial's lowLatencyClient(noRedirectClient(...))) offers h2 in ALPN for ordinary calls (it is a clone of http.DefaultTransport, ForceAttemptHTTP2 on), but a
// request with Connection: Upgrade and Upgrade: websocket needs HTTP/1.1 (net/http: Request.requiresHTTP1), so its dial must drop h2. Pinned end to end against a real TLS server that offers h2:
// the upgrade arrives as HTTP/1.1 and the handshake succeeds, while a plain GET on the same client arrives as HTTP/2 (so the server does offer h2 and the test is not vacuous).
//
// The server's certificate is trusted through SSL_CERT_FILE, which Go's system-roots loader reads once, on the first use in a process: the hub client takes no root pool of its own (it has "no way to
// switch verification off"), and this is the way to give the real constructor a test certificate. Linux only (macOS and Windows read their own store); the test says so when it skips.
func TestTheTunnelUpgradeStaysHTTP1WhileAPlainCallOnTheSameClientUsesHTTP2(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("trusts the test certificate through SSL_CERT_FILE, which only the Linux system-roots loader reads")
	}
	var upgradeProto, plainProto atomic.Int32
	var accepted atomic.Bool
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/plain" {
			plainProto.Store(int32(r.ProtoMajor))
			_, _ = w.Write([]byte("ok"))
			return
		}
		upgradeProto.Store(int32(r.ProtoMajor))
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return // an h2 request cannot be upgraded: the dial then fails, which the test reports
		}
		accepted.Store(true)
		_ = c.Close(websocket.StatusNormalClosure, "test over")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)

	pemFile := filepath.Join(t.TempDir(), "root.pem")
	require.NoError(t, os.WriteFile(pemFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600))
	t.Setenv("SSL_CERT_FILE", pemFile)
	if pool, err := x509.SystemCertPool(); err != nil || pool == nil {
		t.Skip("the system roots could not be read")
	}

	client := cloud.NewHubHTTPClient()
	// A plain GET on this client: HTTP/2 (the server offers it, the client's ALPN asks for it).
	resp, err := client.Get(srv.URL + "/plain")
	if err != nil {
		t.Skipf("the test certificate was not trusted (system roots were loaded before SSL_CERT_FILE was set in this process): %v", err)
	}
	resp.Body.Close()
	assert.Equal(t, 2, resp.ProtoMajor, "a plain call on the hub client uses HTTP/2 when the server offers it")
	assert.EqualValues(t, 2, plainProto.Load())

	// The tunnel's own dial on the same client: the upgrade is HTTP/1.1 and the handshake succeeds (the session itself then fails at the hello, which this server does not speak).
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, derr := tunnel.Dial(ctx, "wss://"+srv.Listener.Addr().String()+"/ws", "tok", tunnel.ClientOptions{HTTPClient: client, Handler: &tunnel.LocalHandler{BaseURL: "http://127.0.0.1:1"}}) // Dial needs a handler; no stream is ever served here
	assert.Error(t, derr, "this server does not speak the tunnel protocol, so the session ends after the handshake")
	t.Logf("tunnel.Dial ended with: %v", derr)
	assert.EqualValues(t, 1, upgradeProto.Load(), "the WebSocket upgrade arrives as HTTP/1.1 even though the server offers h2")
	assert.True(t, accepted.Load(), "the WebSocket handshake succeeded (the server accepted the upgrade)")
}
