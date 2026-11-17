package tunnel_test

import (
	"bytes"
	"context"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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

// #14534 (coral-hub's question, Security's answer on #14529) and #14544 (Security's SHOULD): turning HTTP/2 on at the Hub's load balancer must not move the tunnel's WebSocket upgrade onto
// HTTP/2. The hub client Coral dials with (cloud.NewHubHTTPClient, through tunnel.Dial's lowLatencyClient(noRedirectClient(...))) offers h2 in ALPN for ordinary calls (a clone of
// http.DefaultTransport, ForceAttemptHTTP2 on), but a request with Connection: Upgrade and Upgrade: websocket needs HTTP/1.1 (net/http: Request.requiresHTTP1), so its dial drops h2.
//
// Pinned end to end against a real TLS server that offers h2: the upgrade arrives as HTTP/1.1 and the handshake succeeds, while a plain GET on the same client arrives as HTTP/2 (so the server
// does offer h2 and the test is not vacuous).
//
// The hub client takes no root pool of its own ("no way to switch verification off"), so the real constructor is given the test server's certificate through SSL_CERT_FILE, which Go's
// system-roots loader reads ONCE per process, on first use. An earlier test in this package may already have loaded the roots, so the client half runs in a FRESH process: this test re-executes
// its own binary for TestH2UpgradeChild with SSL_CERT_FILE set in the child's environment, and FAILS (never skips) on Linux if the child cannot trust the certificate or does not pass.

type h2Observed struct {
	plainProto, upgradeProto int32
	accepted                 bool
	childOut                 string
	childErr                 error
}

// guardHolds is the guard itself: the plain call used h2, the upgrade used HTTP/1.1, and the handshake was accepted.
func (o h2Observed) guardHolds() bool {
	return o.plainProto == 2 && o.upgradeProto == 1 && o.accepted
}

// runH2Case starts a TLS server that offers h2, runs the client half in a fresh process in the given mode ("real": the tunnel's own dial; "stub": a stub that sends the upgrade path over h2) and
// reports what the server saw.
func runH2Case(t *testing.T, mode string) h2Observed {
	t.Helper()
	var plainProto, upgradeProto atomic.Int32
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
			return // an h2 request cannot be upgraded: the dial then fails
		}
		accepted.Store(true)
		_ = c.Close(websocket.StatusNormalClosure, "test over")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)

	pemFile := filepath.Join(t.TempDir(), "root.pem")
	require.NoError(t, os.WriteFile(pemFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600))

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestH2UpgradeChild$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), "SSL_CERT_FILE="+pemFile, "CORAL_H2_CHILD=1", "CORAL_H2_ADDR="+srv.Listener.Addr().String(), "CORAL_H2_MODE="+mode)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return h2Observed{plainProto: plainProto.Load(), upgradeProto: upgradeProto.Load(), accepted: accepted.Load(), childOut: out.String(), childErr: err}
}

// TestH2UpgradeChild is the client half, run only by runH2Case in a fresh process (it skips when run on its own). It FAILS if the test certificate is not trusted: the roots were read fresh.
func TestH2UpgradeChild(t *testing.T) {
	if os.Getenv("CORAL_H2_CHILD") != "1" {
		t.Skip("run by the parent test in a fresh process")
	}
	addr, mode := os.Getenv("CORAL_H2_ADDR"), os.Getenv("CORAL_H2_MODE")
	// This child is a throwaway process. The hub client keeps its HTTP/2 connection pooled and its transport is wrapped (CloseIdleConnections cannot reach it), so the package's leak check would report
	// that connection's reader after the test: a passing child says so on its output and ends itself; a failing one ends the ordinary way (non-zero, with the failure shown).
	t.Cleanup(func() {
		if !t.Failed() {
			fmt.Println("H2CHILD-OK mode=" + mode)
			os.Exit(0)
		}
	})
	client := cloud.NewHubHTTPClient()
	resp, err := client.Get("https://" + addr + "/plain")
	require.NoError(t, err, "the child must trust the test certificate through SSL_CERT_FILE (system roots read fresh in this process)")
	resp.Body.Close()
	assert.Equal(t, 2, resp.ProtoMajor, "a plain call on the hub client uses HTTP/2 when the server offers it")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch mode {
	case "real":
		// The tunnel's own dial on the same client: the session ends after the handshake, because this server does not speak the tunnel protocol.
		_, derr := tunnel.Dial(ctx, "wss://"+addr+"/ws", "tok", tunnel.ClientOptions{HTTPClient: client, Handler: &tunnel.LocalHandler{BaseURL: "http://127.0.0.1:1"}})
		assert.Error(t, derr)
		t.Logf("tunnel.Dial ended with: %v", derr)
	case "stub":
		// A stub for "the upgrade went over h2": the same client sends the upgrade path as an ordinary HTTP/2 request.
		r2, gerr := client.Get("https://" + addr + "/ws")
		if gerr == nil {
			r2.Body.Close()
		}
	default:
		t.Fatalf("unknown mode %q", mode)
	}
}

func TestTheTunnelUpgradeStaysHTTP1WhileAPlainCallOnTheSameClientUsesHTTP2(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("trusts the test certificate through SSL_CERT_FILE, which only the Linux system-roots loader reads")
	}
	o := runH2Case(t, "real")
	require.NoError(t, o.childErr, "the fresh-process client half must pass (it fails, never skips, if it cannot trust the certificate):\n%s", o.childOut)
	assert.Contains(t, o.childOut, "H2CHILD-OK mode=real", "the child really ran its assertions and passed (a skip would not say so)")
	assert.NotContains(t, o.childOut, "--- SKIP")
	assert.EqualValues(t, 2, o.plainProto, "the server saw the plain call as HTTP/2")
	assert.EqualValues(t, 1, o.upgradeProto, "the WebSocket upgrade arrives as HTTP/1.1 even though the server offers h2")
	assert.True(t, o.accepted, "the WebSocket handshake succeeded (the server accepted the upgrade)")
	assert.True(t, o.guardHolds())
}

// The guard has teeth: with a stub that sends the upgrade path over HTTP/2, the same observation says the guard does not hold (the server saw ProtoMajor 2 and could not accept the upgrade).
func TestTheH2GuardFailsWhenTheUpgradeGoesH2(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("trusts the test certificate through SSL_CERT_FILE, which only the Linux system-roots loader reads")
	}
	o := runH2Case(t, "stub")
	require.NoError(t, o.childErr, "the stub child must pass:\n%s", o.childOut)
	assert.Contains(t, o.childOut, "H2CHILD-OK mode=stub", "the stub child really ran")
	assert.EqualValues(t, 2, o.upgradeProto, "the stub's upgrade path arrived as HTTP/2")
	assert.False(t, o.accepted, "an h2 request cannot be upgraded")
	assert.False(t, o.guardHolds(), "the guard fails when the upgrade goes h2")
}
