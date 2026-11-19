package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #19802: an agent whose turn ends with an assigned task unclaimed is told again in its Stop hook's feedback, for its highest-priority task, once per task, and never while it has work in progress.
func TestAnAgentThatEndsATurnWithAnAssignedTaskUnclaimedIsToldAgain(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-1980-2000-0000-000000000001"
	name := "claude-" + sid
	board := "team-19802"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Worker", "Worker", name, nil, "all")
	require.NoError(t, err)
	ask := func() map[string]any {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/turn-end", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}

	assert.Equal(t, false, ask()["handoff"], "nothing assigned: the turn ends")

	low, err := h.bs.CreateTask(ctx, board, "low one", "", "low", "Orch", "Worker")
	require.NoError(t, err)
	crit, err := h.bs.CreateTask(ctx, board, "critical one", "", "critical", "Orch", "Worker")
	require.NoError(t, err)
	out := ask()
	require.Equal(t, true, out["handoff"], "an assigned task waits: the Stop hook carries the notice")
	assert.Contains(t, out["context"], claimWaitingText(crit.ID), "the highest priority first")
	assert.NotContains(t, out["context"], claimWaitingText(low.ID))
	assert.Equal(t, false, ask()["handoff"], "once per task: the next turn end is not told again")

	_, err = h.bs.ClaimTask(ctx, board, "Worker", crit.ID)
	require.NoError(t, err)
	assert.Equal(t, false, ask()["handoff"], "work in progress: nothing is said")

	done := "done"
	_, err = h.bs.CompleteTask(ctx, board, crit.ID, "Worker", &done)
	require.NoError(t, err)
	out = ask()
	require.Equal(t, true, out["handoff"], "idle again with the next task waiting: told once more")
	assert.Contains(t, out["context"], claimWaitingText(low.ID))
}
