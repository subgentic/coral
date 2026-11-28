package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent asked to put its own task back in the queue tried task reassign, was refused, and then guessed commands that do not exist (eval #577): the refusal names
// task release for the caller who holds the task, and says nothing new to anyone else. Who may reassign is unchanged.
func TestTheReassignRefusalNamesReleaseForTheTasksOwnAssignee(t *testing.T) {
	t.Parallel()
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	for _, who := range []string{"holder", "other"} {
		_, err := h.bs.Subscribe(ctx, "team", who, "Developer", who, nil, "all", false)
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "Parser", "", "medium", "Orchestrator", "holder")
	require.NoError(t, err)
	path := fmt.Sprintf("%s/api/board/team/tasks/%d/reassign", server.URL, task.ID)
	refusal := func(who string) string {
		resp := postJSON(t, path, map[string]string{"subscriber_id": who, "assignee": ""})
		defer resp.Body.Close()
		require.Equal(t, http.StatusForbidden, resp.StatusCode, who)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		msg, _ := out["error"].(string)
		return msg
	}
	held := refusal("holder")
	assert.Contains(t, held, "may create or reassign shared tasks", "still refused, with the same reason")
	assert.Contains(t, held, fmt.Sprintf("coral-board task release %d", task.ID))
	other := refusal("other")
	assert.Contains(t, other, "may create or reassign shared tasks")
	assert.NotContains(t, other, "task release", "a task you do not hold is not yours to release")
	got, err := h.bs.GetTask(ctx, "team", task.ID)
	require.NoError(t, err)
	require.NotNil(t, got.AssignedTo)
	assert.Equal(t, "holder", *got.AssignedTo, "nothing changed")
}
