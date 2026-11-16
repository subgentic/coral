package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"net/http"
	"testing"
)

func TestTaskCreateReopensClosedGoal16046(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	for _, state := range []string{board.GoalDone, board.GoalDropped} {
		g, err := h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Resume this goal"})
		require.NoError(t, err)
		_, _, err = h.bs.CloseGoal(ctx, "team", g.ID, "finished", state)
		require.NoError(t, err)
		body, _ := json.Marshal(map[string]any{"subscriber_id": "Orchestrator", "title": "More work", "goal_id": g.ID})
		resp, err := http.Post(server.URL+"/api/board/team/tasks", "application/json", bytes.NewReader(body))
		require.NoError(t, err)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		resp.Body.Close()
		require.Equal(t, http.StatusCreated, resp.StatusCode, out)
		assert.Equal(t, true, out["goal_reopened"])
		got, err := h.bs.GetGoal(ctx, "team", g.ID)
		require.NoError(t, err)
		assert.Equal(t, board.GoalActive, got.State)
		assert.Nil(t, got.ClosedAt)
		assert.Empty(t, got.ClosedReason)
		assert.Empty(t, got.ClosedBy)
	}
}
