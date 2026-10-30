package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
)

// GET /api/health is a contract: the native app polls it to detect crashes,
// and hubs and the Cloud Hub use it as their liveness check while a /ws/coral
// feed carries the session list. Changing its shape must be deliberate.
func TestHealthEndpointContract(t *testing.T) {
	for _, hub := range []bool{false, true} {
		dir := t.TempDir()
		cfg := newE2EConfig(t, dir)
		cfg.HubMode = hub
		db, err := storetest.Open(t, cfg.DBPath)
		require.NoError(t, err)
		t.Cleanup(func() { db.Close() })
		stack := newTermStack(t)
		srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)

		ts := httptest.NewServer(srv.Router())
		t.Cleanup(ts.Close)
		resp, err := http.Get(ts.URL + "/api/health")
		require.NoError(t, err)
		defer resp.Body.Close()

		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		keys := make([]string, 0, len(body))
		for k := range body {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		assert.Equal(t, []string{"hub", "hub_owner_stamp", "instance_id", "status", "version"}, keys, "exact field set")
		assert.Equal(t, false, body["hub_owner_stamp"], "no owner stamp secret is installed here (#11378)")
		assert.IsType(t, "", body["instance_id"], "the id of this server run (#245): a command checks it before it sends a credential to the address in the lock file")
		assert.Equal(t, "ok", body["status"])
		assert.IsType(t, "", body["version"])
		// A build without a release Version (tests, make dev) still reports its dev stamp, never "".
		assert.Equal(t, config.ReportedVersion(), body["version"])
		assert.NotEmpty(t, body["version"])
		assert.Equal(t, hub, body["hub"])
	}
}

// The health answer says whether a self-hosted hub's owner stamp secret is installed (#11378): a hub shows Approve and Request changes for this computer only when it is.
func TestHealthSaysWhenTheHubOwnerStampSecretIsInstalled(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	get := func() any {
		resp, err := http.Get(ts.URL + "/api/health")
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		return body["hub_owner_stamp"]
	}
	assert.Equal(t, false, get())
	require.NoError(t, hubowner.WriteFile(cfg.CoralDir(), "ssh-box", strings.Repeat("ab", 32)))
	assert.Equal(t, true, get())
	require.NoError(t, os.Chmod(filepath.Join(cfg.CoralDir(), hubowner.FileName), 0o644))
	if runtime.GOOS != "windows" {
		assert.Equal(t, false, get(), "a secret file readable by others is not an installed secret")
	}
}
