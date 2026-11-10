package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15293 (walk 17 H1): the Orchestrator assigned a task to a killed agent and it waited forever, with nothing said to the assigner. A task is never assigned to an ended agent (its subscription
// names a session that no longer exists here): create, edit and reassign refuse it with 409 assignee_ended and the words that name its state and the way out.
func TestBoard_RefusesAnEndedAssignee(t *testing.T) {
	srv, handler := setupBoardTestServer(t)
	ctx := context.Background()
	handler.SetMemberRestLookup(func(_ context.Context, _, member string) string {
		if member == "Lena" {
			return restStopped
		}
		return ""
	})
	for _, name := range []string{"Lena", "Wally"} {
		_, err := handler.bs.Subscribe(ctx, "p", name, "Developer", "claude-"+archSID2, nil, "")
		require.NoError(t, err)
	}
	do := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		b, _ := json.Marshal(body)
		req, err := http.NewRequest(method, srv.URL+path, bytes.NewReader(b))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	refused := func(code int, out map[string]any, what string) {
		t.Helper()
		assert.Equal(t, http.StatusConflict, code, what)
		assert.Equal(t, "assignee_ended", out["code"], what)
		assert.Contains(t, out["error"], "Lena has ended", what)
		assert.Contains(t, out["error"], "resume it", what)
	}
	code, out := do("POST", "/api/board/p/tasks", map[string]any{"title": "t1", "subscriber_id": "Operator", "assigned_to": "Lena"})
	refused(code, out, "create")
	code, out = do("POST", "/api/board/p/tasks", map[string]any{"title": "t2", "subscriber_id": "Operator", "assigned_to": "Wally"})
	require.Equal(t, http.StatusCreated, code, out)
	id := int64(out["id"].(float64))
	code, out = do("POST", fmt.Sprintf("/api/board/p/tasks/%d/reassign", id), map[string]any{"subscriber_id": "Operator", "assignee": "Lena"})
	refused(code, out, "reassign")
	code, out = do("PATCH", fmt.Sprintf("/api/board/p/tasks/%d", id), map[string]any{"subscriber_id": "Operator", "assigned_to": "Lena"})
	refused(code, out, "edit")
	task, err := handler.bs.GetTask(ctx, "p", id)
	require.NoError(t, err)
	require.NotNil(t, task.AssignedTo)
	assert.Equal(t, "Wally", *task.AssignedTo, "the refused changes left the task with Wally")
}
