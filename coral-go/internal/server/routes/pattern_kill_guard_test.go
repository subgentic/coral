package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// #11157: one agent's pkill -f "go test ./..." ended three other agents whose launch prompts quote that text. The hook's PreToolUse post is answered with a refusal for a Claude agent's Bash
// command that stops processes by a pattern; what stops a pid it started is not refused, and the Operator can turn the check off.
func TestAClaudeAgentsPatternKillIsRefusedAtTheHookPost(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-1157-1b00-0000-000000000001"
	name := "claude-" + sid
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w"}))
	tok := agentToken(t, h, sid, name)

	pending := func(tok, tool, command string) map[string]any {
		body, _ := json.Marshal(map[string]any{"session_id": sid, "tool_use_id": "toolu_1", "tool_name": tool, "tool_input": map[string]any{"command": command}})
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/pending-tool", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}

	out := pending(tok, "Bash", `pkill -f "go test ./..."`)
	refuse, _ := out["refuse"].(string)
	assert.Contains(t, refuse, "pkill", "the reason")
	assert.Contains(t, refuse, "pid=$!", "and what to do instead")
	_, isPending := h.pending.get(sid, time.Now())
	assert.False(t, isPending, "a refused command never runs: it is not a pending tool")

	for _, c := range []string{`kill 1234`, `kill %1`, `sleep 5 & pid=$!; kill "$pid"`, `git commit -m "no pkill -f"`, `timeout 60 go test ./...`} {
		out = pending(tok, "Bash", c)
		assert.Nil(t, out["refuse"], c)
	}
	out = pending(tok, "Read", `pkill -f x`)
	assert.Nil(t, out["refuse"], "another tool is not a shell command")

	// The check turned off: the same command runs.
	require.NoError(t, ss.SetSetting(ctx, settings.RefusePatternKill, "false"))
	out = pending(tok, "Bash", `pkill -f x`)
	assert.Nil(t, out["refuse"], "refuse_pattern_kill is off")
	require.NoError(t, ss.SetSetting(ctx, settings.RefusePatternKill, "true"))
	out = pending(tok, "Bash", `pkill -f x`)
	assert.NotNil(t, out["refuse"])

	// Another agent type's hook answer is not Claude's refusal: nothing is refused for it.
	sid2 := "eeeeeeee-1157-1b00-0000-000000000002"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "codex", AgentName: "echo2", WorkingDir: "/w"}))
	tok2 := agentToken(t, h, sid2, "codex-"+sid2)
	body, _ := json.Marshal(map[string]any{"session_id": sid2, "tool_use_id": "t", "tool_name": "Bash", "tool_input": map[string]any{"command": "pkill -f x"}})
	req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo2/pending-tool", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(store.SessionTokenHeader, tok2)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out2 map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out2)
	assert.Nil(t, out2["refuse"])
}
