package routes

import (
	"context"
	"net/http"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7261 (QA's #7258 point 5, the Orchestrator's call): the ids the message routes read are canonical decimal, as the goal and task ids are since #7239: "01", "+1", " 1" and "1.0" are refused, not another
// spelling of 1 (a path allowlist or a cache keyed on the literal path would see a second spelling).
func TestMessageIdsAreCanonical(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	msg, err := h.bs.PostMessage(ctx, "team", "Orchestrator", "hello", nil)
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "team", "t", "", "medium", "Orchestrator")
	require.NoError(t, err)
	call := goalCall(t, server.URL)
	id := strconv.FormatInt(msg.ID, 10)
	tid := strconv.FormatInt(task.ID, 10)

	for _, bad := range []string{"0" + id, "%2B" + id, "%20" + id, id + "%20", id + ".0", "0x" + id, "-" + id, "abc"} {
		code, out := call("GET", "/api/board/team/messages/all?id="+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, "message id %q: %v", bad, out)
		code, out = call("GET", "/api/board/team/messages/all?task_id="+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, "task_id %q: %v", bad, out)
		code, out = call("DELETE", "/api/board/team/messages/"+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, "DELETE message %q: %v", bad, out)
	}
	req, _ := http.NewRequest("GET", server.URL+"/api/board/team/messages/all?id="+id, nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode, "the canonical message id still reads it")
	req, _ = http.NewRequest("GET", server.URL+"/api/board/team/messages/all?task_id="+tid, nil)
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode, "the canonical task_id still reads the replies")
	code, _ := call("DELETE", "/api/board/team/messages/99999", nil)
	assert.Equal(t, http.StatusNotFound, code, "a canonical id that is not there is 404")
	code, _ = call("GET", "/api/board/team/messages/all?id=0", nil)
	assert.Equal(t, http.StatusNotFound, code, "id 0 stays what it was: not found")
	code, _ = call("GET", "/api/board/team/messages/all?task_id=0", nil)
	assert.Equal(t, http.StatusBadRequest, code, "task_id 0 stays refused")
}
