package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #15708 (generation 9): the self-hosted Hub's signed-in owner reads an agent's loaded skills and MCP servers on a remote computer. Both are person-only reads the remote refused a key for, so
// through the Hub they answered 403. The Hub now signs them; a script holding the Hub's key, a forged stamp and a Hub that holds no secret are all still refused.
func TestTheOwnerAtTheHubReadsAnAgentsSkillsAndMCPServersOnARemoteAndNobodyElseCan(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	sid := "eeeeeeee-1387-1b00-0000-000000015708"
	name := "claude-" + sid
	terminal.addSession(name, "/w")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w"}))
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Get("/api/sessions/live/{name}/loaded-skills", h.AgentLoadedSkills)
		rr.Get("/api/sessions/live/{name}/mcp-servers", h.AgentMCPServers)
	}
	read := func(w *stampWorld, which string, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest("GET", w.hub.URL+"/api/remote/ssh-box/api/sessions/live/echo/"+which+"?session_id="+sid+"&agent_type=claude", nil)
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		b, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out
	}

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	for _, which := range []string{"loaded-skills", "mcp-servers"} {
		code, out := read(w, which, func(*http.Request) {})
		assert.Equal(t, http.StatusOK, code, "the owner at the Hub reads %s: %v", which, out)

		// a script with the Hub's key (no signed-in session) is refused, and a forged stamp is no better
		code, out = read(w, which, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
		assert.Equal(t, http.StatusForbidden, code, "%s by key: %v", which, out)
		code, _ = read(w, which, func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
			r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
		})
		assert.Equal(t, http.StatusForbidden, code, "%s by forged stamp", which)
	}

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	for _, which := range []string{"loaded-skills", "mcp-servers"} {
		code, out := read(w2, which, func(*http.Request) {})
		assert.Equal(t, http.StatusForbidden, code, "%s without a secret: %v", which, out)
	}
}
