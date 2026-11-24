package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/pkg/hubproxy"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20979: an Allow through a Hub with nothing simulated between the browser and the router: a real hub proxy, a real tunnel and the connector's LocalHandler with the real route table (the gate open for this test),
// in front of the real Coral router. The owner's device signs, the Hub carries it, the computer verifies it and Allows, and only the browser that holds the one-time key opens the code.
func TestAnAllowThroughARealHubAndTunnelGivesTheCodeOnlyToTheBrowserThatHoldsTheKey(t *testing.T) {
	g := newLinkRig(t, true)
	local := httptest.NewServer(g.d.r.srv.Router())
	t.Cleanup(local.Close)
	cur := routes.MaxModeFromSettings(g.d.ss)
	sessions := make(chan *tunnel.Session, 1)
	ths := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := tunnel.AcceptHTTP(w, r, func(context.Context, string) (any, error) { return "x", nil }, tunnel.SessionConfig{})
		if err == nil {
			sessions <- s
		}
	}))
	t.Cleanup(ths.Close)
	cs, err := tunnel.Dial(context.Background(), "ws"+strings.TrimPrefix(ths.URL, "http"), "tok", tunnel.ClientOptions{
		Handler:       &tunnel.LocalHandler{Redactor: secrets.Redactor(), BaseURL: local.URL, AllowRequest: tunnel.AllowRequest(cur), MaxMode: cur, ViaValue: cloud.ViaSecret(), LinkID: testLinkID},
		AllowInsecure: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { cs.Close() })
	sess := <-sessions
	t.Cleanup(func() { sess.Close() })

	hub := httptest.NewUnstartedServer(nil)
	proxy := hubproxy.NewWithOptions(oneTunnel{sess}, hubproxy.Options{AllowedOrigins: []string{hub.Listener.Addr().String()}})
	r := chi.NewRouter()
	r.Handle("/api/remote/{server}/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// What Coral Hub itself does for the account this computer is linked to: it vouches for the person and the role.
		ctx := tunnel.WithHubRole(tunnel.WithHubUser(req.Context(), relayOwner), tunnel.HubRoleOwner)
		proxy.ServeHTTP(w, req.WithContext(ctx))
	}))
	hub.Config.Handler = r
	hub.Start()
	t.Cleanup(hub.Close)

	viaHub := func(id, signedFor, sentWith, nonce string) (int, []byte) {
		signedTarget := "/api/cloud/link-requests/" + id + "/allow?box_pk=" + signedFor
		body := `{"cap":"view"}`
		m := devicekey.Relayed{Kind: devicekey.AllowLink, KID: g.ownK, Computer: g.d.key.Computer(), Ts: time.Now().Unix(), Nonce: nonce, Link: testLinkID, HubUser: relayOwner, Method: "POST", Path: signedTarget, BodySHA256: devicekey.BodySHA256([]byte(body))}
		canon, err := m.Canonical()
		require.NoError(t, err)
		sig := signP1363(t, g.owner, devicekey.RelayedSigningInput(devicekey.AllowLink, canon))
		req, _ := http.NewRequest("POST", hub.URL+"/api/remote/srv/api/cloud/link-requests/"+id+"/allow?box_pk="+sentWith, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", hub.URL)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set(tunnel.HubUserHeader, relayOwner)
		req.Header.Set(tunnel.DeviceKeyHeader, g.ownK)
		req.Header.Set(tunnel.DeviceSigHeader, sig)
		req.Header.Set(tunnel.DeviceTsHeader, fmt.Sprint(m.Ts))
		req.Header.Set(tunnel.DeviceNonceHeader, nonce)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return resp.StatusCode, buf.Bytes()
	}

	b, other := newBrowser(t), newBrowser(t)
	id := g.pending(t, "interact")

	// A Hub that swaps the browser's key after the owner signed: the computer refuses, and the request is still waiting.
	code, out := viaHub(id, b.pk, other.pk, g.nonceN())
	assert.NotEqual(t, 200, code, string(out))
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State, "a swapped key allowed nothing")

	// The real one.
	nonce := g.nonceN()
	code, out = viaHub(id, b.pk, b.pk, nonce)
	require.Equal(t, 200, code, string(out))
	assert.NotRegexp(t, regexp.MustCompile(`\d{8}`), string(out), "the Hub carried no code in the clear")
	var rep struct {
		Box json.RawMessage `json:"box"`
		Cap string          `json:"cap"`
	}
	require.NoError(t, json.Unmarshal(out, &rep))
	assert.Equal(t, "view", rep.Cap)
	opened, err := b.open(t, rep.Box, "allow-link", nonce, id)
	require.NoError(t, err)
	assert.Regexp(t, `^\d{8}$`, opened, "the browser that made the key opens the code")
	_, err = other.open(t, rep.Box, "allow-link", nonce, id)
	assert.Error(t, err, "the Hub's own key opens nothing")
	st, _ = g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "allowed", st.State)
}
