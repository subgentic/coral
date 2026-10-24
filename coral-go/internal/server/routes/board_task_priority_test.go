package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7211 (Security's note): a task create with a priority that is not one of critical, high, medium or low is a clean 400 "invalid priority" from the Go check, not the database's CHECK text, and
// stores nothing; an empty priority is medium.
func TestTaskCreateChecksThePriorityInGo(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	post := func(priority any) (int, map[string]any) {
		payload := map[string]any{"title": "t", "created_by": "Orchestrator", "subscriber_id": "Orchestrator"}
		if priority != nil {
			payload["priority"] = priority
		}
		b, _ := json.Marshal(payload)
		resp, err := http.Post(server.URL+"/api/board/team/tasks", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	count := func() int {
		page, err := h.bs.ListTaskPage(ctx, "team", board.TaskListQuery{Status: "all", Limit: board.TaskListMaxLimit})
		require.NoError(t, err)
		return len(page.Tasks)
	}

	for _, bad := range []string{"banana", "High", "urgent", " high", "high ", "0"} {
		code, out := post(bad)
		assert.Equal(t, http.StatusBadRequest, code, "%q: %v", bad, out)
		assert.Contains(t, out["error"], "invalid priority", bad)
		assert.NotContains(t, out["error"], "CHECK", "the database's own text is not the answer: %q", bad)
	}
	assert.Zero(t, count(), "a refused priority stores nothing")

	for _, good := range []string{"critical", "high", "medium", "low"} {
		code, out := post(good)
		assert.Equal(t, http.StatusCreated, code, "%s: %v", good, out)
		assert.Equal(t, good, out["priority"])
	}
	code, out := post("")
	assert.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, "medium", out["priority"], "empty is medium")
	code, out = post(nil)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, "medium", out["priority"])
	assert.Equal(t, 6, count())
}
