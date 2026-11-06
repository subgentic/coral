package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/peercred"
)

// #409 (PATH B): the cloud gate reads the connection's own cached verdict, with #385's retry, not a table read of its own. Over real loopback
// connections with the main server's ConnContext and the attribution stubbed: a connection whose user can't be told yet gets 503 "try again"
// (never 403 other_user), and `coral cloud connect`'s hello, sent again on a new connection, goes through once the attribution says Coral's
// user. Another user's connection is still refused 403 other_user, and the relay too (#396).
func TestCloudHelloWaitsForAnUndecidedConnectionAndRefusesOnlyAnotherUser(t *testing.T) {
	r := newE2ERemote(t, "cloud-hello-peer", nil)
	token, err := cloud.ReadCLIToken(r.cfg.CoralDir())
	require.NoError(t, err)

	var answers []peercred.Verdict // one per attribution, in order; the last one repeats
	var calls atomic.Int32
	t.Cleanup(auth.ResetPeerCheckLostForTest)
	t.Cleanup(auth.SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
		n := int(calls.Add(1)) - 1
		if n >= len(answers) {
			n = len(answers) - 1
		}
		return answers[n], nil
	}))
	r.srv.cloudHandler.UseConnPeerCheck() // the rig pins "unsupported" for its in-memory requests; these are real loopback connections
	ts := httptest.NewUnstartedServer(r.srv.Router())
	ts.Config.ConnContext = auth.ConnContext
	ts.Start()
	t.Cleanup(ts.Close)

	hello := func() (int, map[string]any, http.Header) {
		t.Helper()
		tr := &http.Transport{}
		defer tr.CloseIdleConnections()
		req, err := http.NewRequest("POST", ts.URL+cliauth.CLIHelloPath, strings.NewReader(`{"nonce":"`+strings.Repeat("A", 43)+`"}`))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Transport: tr}).Do(req)
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		return resp.StatusCode, body, resp.Header
	}

	answers = []peercred.Verdict{peercred.Unattributed}
	calls.Store(0)
	code, body, hdr := hello()
	assert.Equal(t, http.StatusServiceUnavailable, code, "not told yet: try again, not another user")
	assert.Equal(t, cliauth.PeerUndecidedCode, body["code"])
	assert.Equal(t, "1", hdr.Get("Retry-After"))

	for _, v := range []peercred.Verdict{peercred.OtherUser, peercred.Relay} {
		answers = []peercred.Verdict{v}
		calls.Store(0)
		code, body, _ = hello()
		assert.Equal(t, http.StatusForbidden, code, "%v: definitely another user", v)
		assert.Equal(t, "other_user", body["code"], "%v", v)
	}

	// Twice not told, then Coral's user: the command line's signed request goes through, its hello retried on new connections.
	answers = []peercred.Verdict{peercred.Unattributed, peercred.Unattributed, peercred.Self}
	calls.Store(0)
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	c := &http.Client{Transport: cliauth.Transport{Base: tr, Token: token}}
	resp, err := c.Post(ts.URL+"/api/cloud/redeem", "application/json", strings.NewReader(`{"check":true}`))
	require.NoError(t, err, "the hello is retried until the connection is told")
	resp.Body.Close()
	assert.NotContains(t, []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusServiceUnavailable}, resp.StatusCode, "the signed request is admitted")
	assert.GreaterOrEqual(t, calls.Load(), int32(3), "each retry was a new connection, attributed afresh")
}
