package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/mcpview"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #9769: GET /api/sessions/live/{name}/mcp-servers lists an agent's configured MCP servers (name, transport, scope), read-only, from the CLI's own files in a temporary home; the Operator's alone.
func TestAgentMCPServersRoute(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	home, folder := t.TempDir(), t.TempDir()
	old := mcpEnvSource
	mcpEnvSource = func() mcpview.Env { return mcpview.Env{Home: home} }
	t.Cleanup(func() { mcpEnvSource = old })
	require.NoError(t, os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers": {"github": {"type": "http", "url": "https://secret.example/mcp", "headers": {"Authorization": "Bearer SECRET-9"}}}}`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(folder, ".mcp.json"), []byte(`{"mcpServers": {"files": {"command": "/bin/secret-cmd", "env": {"K": "SECRET-9"}}}}`), 0o600))
	sid, other := "11111111-aaaa-4000-8000-000000000001", "22222222-bbbb-4000-8000-000000000002"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", WorkingDir: folder}))
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: other, AgentName: "term", AgentType: "terminal", WorkingDir: folder}))

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get(testDashboardHeader) != "" {
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/api/sessions/live/{name}/mcp-servers", h.AgentMCPServers)
	get := func(path string, hdr map[string]string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code, w.Body.String()
	}
	dash := map[string]string{testDashboardHeader: "1"}

	code, body := get("/api/sessions/live/dev/mcp-servers?session_id="+sid, dash)
	require.Equal(t, http.StatusOK, code, body)
	var res mcpview.Result
	require.NoError(t, json.Unmarshal([]byte(body), &res))
	assert.Equal(t, "claude", res.AgentType)
	assert.True(t, res.Supported)
	require.Len(t, res.Servers, 2)
	assert.Equal(t, mcpview.Server{Name: "github", Transport: "http", Scope: mcpview.ScopeUser}, res.Servers[0])
	assert.Equal(t, mcpview.Server{Name: "files", Transport: "stdio", Scope: mcpview.ScopeProject}, res.Servers[1])
	for _, leaked := range []string{"secret.example", "SECRET-9", "secret-cmd", "Authorization"} {
		assert.NotContains(t, body, leaked, "no command, environment, header or URL reaches the answer")
	}

	code, body = get("/api/sessions/live/term/mcp-servers?session_id="+other, dash)
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, body, `"supported":false`, "a CLI that is not read says so")

	code, _ = get("/api/sessions/live/dev/mcp-servers?session_id=33333333-cccc-4000-8000-000000000003", dash)
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = get("/api/sessions/live/dev/mcp-servers", dash)
	assert.Equal(t, http.StatusBadRequest, code, "a session is named")

	for name, hdr := range map[string]map[string]string{"nobody": nil, "an agent's token": {testAgentHeader: "s1"}, "Coral Hub": {tunnel.ViaHeader: "x"}} {
		code, _ = get("/api/sessions/live/dev/mcp-servers?session_id="+sid, hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
}
