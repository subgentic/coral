package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #10466 (Security Reviewer Windows, on #10381): a launch must never record a mode its CLI lacks. A saved default of Accept edits made a Codex launch record acceptEdits (Codex's Accept edits flags are
// its Default ones): the recorded mode is what a restart, a wake and a resurrect restore and what the chat says. Through POST /api/sessions/launch, for each CLI and each saved default, and for the raw
// flags that read as Accept edits: the recorded mode is the one the CLI has, else Default.
func TestALaunchRecordsOnlyAModeItsCLIHas(t *testing.T) {
	server, _, _, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	launch := func(agentType string, body map[string]any) string {
		t.Helper()
		body["agent_type"] = agentType
		body["working_dir"] = t.TempDir()
		b, _ := json.Marshal(body)
		resp, err := http.Post(server.URL+"/api/sessions/launch", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		var res map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
		require.Equal(t, http.StatusOK, resp.StatusCode, "%v", res)
		ls, err := ss.GetLiveSession(ctx, res["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls)
		require.NotNil(t, ls.PermissionMode, "a mode is recorded")
		return *ls.PermissionMode
	}
	modes := []string{"default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"}
	want := map[string]map[string]string{ // CLI -> saved default -> recorded
		at.Claude: {"default": "default", "plan": "plan", "acceptEdits": "acceptEdits", "auto": "auto", "bypassPermissions": "bypassPermissions", "dontAsk": "dontAsk"},
		at.Codex:  {"default": "default", "plan": "plan", "acceptEdits": "default", "auto": "auto", "bypassPermissions": "bypassPermissions", "dontAsk": "dontAsk"},
		at.Agy:    {"default": "default", "plan": "plan", "acceptEdits": "acceptEdits", "auto": "default", "bypassPermissions": "bypassPermissions", "dontAsk": "default"},
		at.Pi:     {"default": "default", "plan": "default", "acceptEdits": "default", "auto": "default", "bypassPermissions": "default", "dontAsk": "default"},
	}
	for cli, byMode := range want {
		for _, saved := range modes {
			require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", saved))
			assert.Equal(t, byMode[saved], launch(cli, map[string]any{}), "%s with %s saved", cli, saved)
		}
	}
	// the raw flags that read as Accept edits to Codex are Default's too
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	assert.NotEqual(t, "acceptEdits", launch(at.Codex, map[string]any{"flags": []string{"--sandbox", "workspace-write", "-a", "on-request"}}), "Codex's own Accept edits flags record the mode Codex has")
	// an explicit Default stays Default for every CLI
	for cli := range want {
		assert.Equal(t, "default", launch(cli, map[string]any{"permission_mode": "default"}), cli)
	}
}
