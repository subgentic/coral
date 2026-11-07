package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14133, Security: a restarted worker now acts on the tasks assigned to it, so a task another worker could put on its queue would be an injection path. Only the Operator and an active registered
// orchestrator create or reassign tasks for others; an agent can make a task for itself alone. This pins it.
func TestAWorkerCannotPutATaskOnAnotherWorkersQueue(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "proj", "Orchestrator")
	base := server.URL + "/api/board/proj"
	for _, w := range []string{"Dev A", "Dev B"} {
		resp := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": w, "job_title": w})
		resp.Body.Close()
	}
	status := func(body map[string]string) int {
		resp := postJSON(t, base+"/tasks", body)
		defer resp.Body.Close()
		return resp.StatusCode
	}
	assert.Equal(t, http.StatusForbidden, status(map[string]string{"title": "do this", "created_by": "Dev A", "assigned_to": "Dev B"}), "a worker's task for another worker")
	assert.Equal(t, http.StatusForbidden, status(map[string]string{"title": "do this", "created_by": "Dev A"}), "nor an unassigned shared task")

	// the assignment it could not make at creation cannot be made by reassigning either
	resp := postJSON(t, base+"/tasks", map[string]string{"title": "mine", "created_by": "Orchestrator", "assigned_to": "Dev A"})
	resp.Body.Close()
	resp = postJSON(t, base+"/tasks/1/reassign", map[string]string{"subscriber_id": "Dev A", "assigned_to": "Dev B"})
	defer resp.Body.Close()
	assert.GreaterOrEqual(t, resp.StatusCode, 400, "a worker cannot reassign a task to another worker")
	assert.Less(t, resp.StatusCode, 500)

	// the orchestrator can
	assert.Equal(t, http.StatusCreated, status(map[string]string{"title": "ok", "created_by": "Orchestrator", "assigned_to": "Dev B"}))
	// and an agent's own self task never names another assignee
	require.Equal(t, http.StatusForbidden, status(map[string]string{"title": "x", "created_by": "Dev A", "assigned_to": "Dev B", "self": "true"}), "--self cannot name another worker")
}
