package routes

import (
	"context"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14861 (the Operator): the team page's Agents view has Open tasks (pending, in progress and in review, assigned to the agent) and Time on current task (since the claim of its task in progress). The status route sends both:
// open_tasks, a number for every agent, and task_since, the claim's time, only while a task is in progress.
func TestTeamStatusCarriesOpenTasksAndTaskSince(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "load-team"
	for _, name := range []string{"busy", "idle"} {
		sid := uuid.NewString()
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
		_, err := h.bs.Subscribe(ctx, team, name, "Developer", "claude-"+sid, nil, "all")
		require.NoError(t, err)
		terminal.addSession("claude-"+sid, "/tmp")
	}
	_, err := h.bs.CreateTask(ctx, team, "First, claimed", "", "high", "lead", "busy")
	require.NoError(t, err)
	_, err = h.bs.CreateTask(ctx, team, "Second, waiting its turn", "", "medium", "lead", "busy")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, team, "busy")
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/status", h.TeamAvailability)
	body := decodeListBody(t, r, "/api/board/"+team+"/status")

	busy := rowWhere(t, body, "agents", "name", "busy")
	assert.EqualValues(t, 2, busy["open_tasks"], "a task in progress and a pending one are two open tasks")
	since, _ := busy["task_since"].(string)
	require.NotEmpty(t, since, "the claim of its task in progress")
	at, err := time.Parse(time.RFC3339, since)
	if err != nil {
		at, err = time.Parse("2006-01-02T15:04:05Z", since)
	}
	require.NoError(t, err, since)
	assert.WithinDuration(t, time.Now(), at, 2*time.Minute, "claimed just now")

	idle := rowWhere(t, body, "agents", "name", "idle")
	assert.EqualValues(t, 0, idle["open_tasks"], "no task: a zero, not a missing key")
	_, hasSince := idle["task_since"]
	assert.False(t, hasSince, "no task in progress: no claim time")
}
