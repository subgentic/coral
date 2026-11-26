package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21558: through the real router, in hub-only mode, a proxied request or a public Host is refused (403 hub_only) whatever credential it brings, and the Hub's own tunnel request is let through to the route
// table (the gate does not answer it).
func TestHubOnlyRouterRefusesProxiedRequestsAndLetsTheTunnelThrough(t *testing.T) {
	r := newE2ERemote(t, "hub-only-gate", nil)
	h := r.srv.Router()
	auth.SetHubOnly(true)
	t.Cleanup(func() { auth.SetHubOnly(false) })

	for name, hdr := range map[string]map[string]string{
		"a forwarding header":                  {"X-Forwarded-For": "203.0.113.9"},
		"a forwarding header and a bearer key": {"X-Forwarded-For": "203.0.113.9", "Authorization": "Bearer anything"},
		"Via":                                  {"Via": "1.1 proxy"},
		"a forged tunnel stamp":                {tunnel.ViaHeader: "1"},
	} {
		rec := call(h, "GET", "/api/system/privacy", "", hdr)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.Contains(t, rec.Body.String(), "hub_only", name)
	}
	rec := call(h, "GET", "/api/system/privacy", "", map[string]string{"X-Forwarded-For": "203.0.113.9", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-1234abcd"})
	assert.NotContains(t, rec.Body.String(), "hub_only", "the Hub's connector is not refused by the gate (the route table decides what it may reach)")
}

// The local command line keeps working in hub-only mode: a signed call from this computer, with a credential required on loopback.
func TestHubOnlyKeepsTheSignedCommandLineWorking(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	auth.SetHubOnly(true)
	t.Cleanup(func() { auth.SetHubOnly(false); auth.SetRequireAuthOnLoopback(false) })
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	assert.True(t, auth.RequireAuthOnLoopback(), "hub-only forces a credential on this computer too")
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)

	tok, err := cloud.ReadCLIToken(cfg.CoralDir())
	require.NoError(t, err)
	resp, err := cloud.CLIClient{Base: local.URL, Token: tok}.Do(context.Background(), http.MethodGet, "/api/sessions/live", nil, nil, 5*time.Second)
	require.NoError(t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	assert.Equal(t, http.StatusOK, resp.StatusCode, string(body))

	req, _ := http.NewRequest(http.MethodGet, local.URL+"/api/sessions/live", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	raw, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	raw.Body.Close()
	assert.Equal(t, http.StatusForbidden, raw.StatusCode, "the same route, proxied, is refused")
}
