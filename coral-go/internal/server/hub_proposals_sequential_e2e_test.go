package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubproxy"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14663 (coral-hub #193127, reopening #14656): through the Hub only GET /api/proposals was refused 429 after volume, with no recovery, while the same Hub's needs-you and asks reads got 200 at the same moment and
// 70 of 70 direct proposals reads were fine. The whole chain, as TestHubOperatorEndToEnd builds it (the real hub proxy, a real tunnel, the connector's LocalHandler, the real Coral router): 300 sequential reads of each
// route through the Hub as one Hub user, each with the headers a browser sends, and the answer to every one is 200.
func TestSequentialProposalsReadsThroughTheHubAreNeverRefused(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	ss := store.NewSessionStore(db)
	require.NoError(t, ss.SetSetting(context.Background(), routes.MaxModeSetting, tunnel.TierInteract.String()))
	cur := routes.MaxModeFromSettings(ss)
	sessions := make(chan *tunnel.Session, 1)
	ths := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := tunnel.AcceptHTTP(w, r, func(context.Context, string) (any, error) { return "x", nil }, tunnel.SessionConfig{})
		if err == nil {
			sessions <- s
		}
	}))
	t.Cleanup(ths.Close)
	cs, err := tunnel.Dial(context.Background(), "ws"+strings.TrimPrefix(ths.URL, "http"), "tok", tunnel.ClientOptions{
		Handler:       &tunnel.LocalHandler{Redactor: secrets.Redactor(), BaseURL: local.URL, AllowRequest: tunnel.AllowRequest(cur), MaxMode: cur, ViaValue: cloud.ViaSecret()},
		AllowInsecure: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { cs.Close() })
	sess := <-sessions
	t.Cleanup(func() { sess.Close() })
	routes.SetHubOwnerLabel(func(context.Context) (string, error) { return "hub-user-1234abcd", nil })
	t.Cleanup(func() { routes.SetHubOwnerLabel(func(context.Context) (string, error) { return "", nil }) })
	hub := httptest.NewUnstartedServer(nil)
	r := chi.NewRouter()
	r.Handle("/api/remote/{server}/*", hubproxy.NewWithOptions(ownerTunnel{oneTunnel{sess}}, hubproxy.Options{AllowedOrigins: []string{hub.Listener.Addr().String()}}))
	hub.Config.Handler = r
	hub.Start()
	t.Cleanup(hub.Close)

	const user = "hub-user-1234abcd"
	get := func(path string) (int, string, http.Header) {
		req, _ := http.NewRequest(http.MethodGet, hub.URL+"/api/remote/srv"+path, nil)
		req.Header.Set("Origin", hub.URL)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Add(tunnel.HubUserHeader, user)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header
	}
	for _, path := range []string{"/api/proposals?state=pending,approving,expired", "/api/sessions/live"} {
		refused := 0
		for i := 0; i < 300; i++ {
			code, body, hdr := get(path)
			if code != http.StatusOK {
				refused++
				if refused == 1 {
					t.Logf("%s: read %d answered %d, Retry-After %q, X-Coral-Limit %q: %.160s", path, i+1, code, hdr.Get("Retry-After"), hdr.Get("X-Coral-Limit"), body)
				}
			}
		}
		assert.Zero(t, refused, "%s: no read of 300 through the Hub was refused", path)
	}
}

// ownerTunnel is oneTunnel with the Hub's owner stamp on every request, as the Hub puts it on the stream of the account the machine is enrolled to.
type ownerTunnel struct{ oneTunnel }

func (o ownerTunnel) Resolve(ctx context.Context, id string) (hubproxy.Target, error) {
	t, err := o.oneTunnel.Resolve(ctx, id)
	if err != nil {
		return nil, err
	}
	return ownerTarget{t}, nil
}

type ownerTarget struct{ hubproxy.Target }

func (o ownerTarget) RoundTrip(req *http.Request) (*http.Response, error) {
	return o.Target.RoundTrip(req.WithContext(tunnel.WithHubRole(req.Context(), tunnel.HubRoleOwner)))
}
