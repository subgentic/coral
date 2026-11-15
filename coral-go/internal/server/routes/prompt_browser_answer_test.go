package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// Security's SHOULD on #16609 (#16684): the client draws only "Not now" for Claude's browser menu, but the answer route took any row, so a direct POST with n 1 or 3 sent
// "Install extension" (opens the person's Chrome) or "Don't ask again" (lasting). Only "Not now" is answered from here; the rest is the person's, in the agent's own chat.
func TestBrowserMenuAnswerRefusesEverythingButNotNow(t *testing.T) {
	const sid = "bbbbbbbb-1111-2222-3333-444444444444"
	server, _, terminal, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-browser", WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-browser", "/tmp/test")
	fastPromptChecks(t)
	terminal.mu.Lock()
	terminal.outputs["claude-browser"] = browserScreen
	terminal.mu.Unlock()
	answer := func(n int, label string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"n": n, "label": label, "session_id": sid, "agent_type": "claude"})
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/sessions/live/claude-browser/answer-prompt", bytes.NewReader(b))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}
	for n, label := range map[int]string{1: "Install extension", 3: "Don't ask again"} {
		code, body := answer(n, label)
		assert.Equal(t, http.StatusConflict, code, label)
		assert.Equal(t, "browser_choice", body["code"], label)
	}
	_, body := answer(2, "Not now") // the mock terminal's selection does not move, so the answer itself may end "prompt_still_open"; what matters is that the gate lets it through
	assert.NotEqual(t, "browser_choice", body["code"], "Not now is the one answer the route takes")
}
