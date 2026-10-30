package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11247 (QA's #11216): any member may make a task for ITSELF (task add --self --goal N), so the release's "UI review" can be opened without an orchestrator. It assigns work to nobody else: the assignee
// is the creator, a goal is required, a repeat of an open title returns that task, and at most maxOpenSelfTasks are open at once.
func TestAnAgentMayMakeATaskForItselfAndOnlyForItself(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "myproject", "Orchestrator")
	base := server.URL + "/api/board/myproject"
	for _, who := range []string{"QA Engineer", "Backend Dev"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	goal, err := h.bs.CreateGoal(context.Background(), "myproject", board.GoalInput{Title: "Releases are checked", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	create := func(body map[string]any) (int, map[string]any) {
		resp := postJSON(t, base+"/tasks", body)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// Without --self a member who is not an orchestrator still may not create a shared task.
	code, out := create(map[string]any{"title": "UI review: v2.0.7", "subscriber_id": "QA Engineer", "goal_id": goal.ID})
	assert.Equal(t, http.StatusForbidden, code, "%v", out)

	// With it: created, assigned to its creator, linked to the goal.
	code, out = create(map[string]any{"title": "UI review: v2.0.7", "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, "QA Engineer", out["assigned_to"])
	assert.Equal(t, "QA Engineer", out["created_by"])
	id := out["id"]

	// A repeat of the title returns the existing task (any case, any spacing), and makes none.
	code, out = create(map[string]any{"title": "  ui review: V2.0.7 ", "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, id, out["id"])
	assert.Equal(t, true, out["existing"], "marked, so a caller can tell it from a new one")
	open, err := h.bs.OpenSelfTasks(context.Background(), "myproject", "QA Engineer")
	require.NoError(t, err)
	assert.Len(t, open, 1)
	// the same title by another agent is that agent's own
	code, out = create(map[string]any{"title": "UI review: v2.0.7", "subscriber_id": "Backend Dev", "goal_id": goal.ID, "self": true})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.NotEqual(t, id, out["id"])

	// It can never assign work to someone else, with a goal or without one.
	code, out = create(map[string]any{"title": "Do my work", "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true, "assigned_to": "Backend Dev"})
	assert.Equal(t, http.StatusForbidden, code, "%v", out)
	code, out = create(map[string]any{"title": "Do my work", "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true, "assigned_to": "QA Engineer"})
	assert.Equal(t, http.StatusCreated, code, "assigning it to itself is allowed: %v", out)

	// A goal is required.
	code, out = create(map[string]any{"title": "No goal", "subscriber_id": "QA Engineer", "self": true})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "goal_required", out["code"])

	// Only a member of the board.
	code, out = create(map[string]any{"title": "Mine", "subscriber_id": "Stranger", "goal_id": goal.ID, "self": true})
	assert.Equal(t, http.StatusForbidden, code, "%v", out)

	// The queue cannot be flooded: at most maxOpenSelfTasks open at once, each agent's own count.
	for i := 0; i < maxOpenSelfTasks; i++ {
		code, out = create(map[string]any{"title": fmt.Sprintf("Flood %d", i), "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true})
		if code != http.StatusCreated {
			break
		}
	}
	code, out = create(map[string]any{"title": "One too many", "subscriber_id": "QA Engineer", "goal_id": goal.ID, "self": true})
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "too_many_self_tasks", out["code"])
	open, err = h.bs.OpenSelfTasks(context.Background(), "myproject", "QA Engineer")
	require.NoError(t, err)
	assert.Len(t, open, maxOpenSelfTasks)
	code, _ = create(map[string]any{"title": "Backend's own", "subscriber_id": "Backend Dev", "goal_id": goal.ID, "self": true})
	assert.Equal(t, http.StatusCreated, code, "another agent's count is its own")
}
