package routes

import (
	"bytes"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkingModeAPI(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/working-mode", h.GetWorkingMode)
	r.Put("/api/board/{project}/working-mode", h.SetWorkingMode)
	call := func(method, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(method, "/api/board/team/working-mode", bytes.NewBufferString(body)))
		return w
	}
	w := call("GET", "")
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), `"mode":"none"`)
	w = call("PUT", `{"mode":"worktrees","dependency_guidance":true,"custom_instructions":"Use make test.","instructions":"forged"}`)
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), "isolated Git worktree")
	require.NotContains(t, w.Body.String(), "forged")
	var saved map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &saved))
	w = call("PUT", `{"mode":"bad"}`)
	require.Equal(t, 400, w.Code)
	oversized, _ := json.Marshal(map[string]any{"mode": "none", "custom_instructions": strings.Repeat("x", 4097)})
	require.Equal(t, 400, call("PUT", string(oversized)).Code)
	w = call("GET", "")
	var current map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &current))
	require.Equal(t, saved, current)
	w = call("PUT", `{"mode":"none"}`)
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), `"instructions":""`)
}

// The "Requests for work are tasks" switch goes through the working-mode route: saved, read back, and the rule is in the instructions the route returns; a PUT that leaves it out turns it off (omitted fields reset).
func TestWorkingModeAsksAreTasksSwitch(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/working-mode", h.GetWorkingMode)
	r.Put("/api/board/{project}/working-mode", h.SetWorkingMode)
	call := func(method, body string) map[string]any {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(method, "/api/board/team/working-mode", bytes.NewBufferString(body)))
		require.Equal(t, 200, w.Code, w.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return out
	}
	require.Equal(t, false, call("GET", "")["asks_are_tasks"], "a team that never set it: off")
	on := call("PUT", `{"mode":"none","asks_are_tasks":true}`)
	require.Equal(t, true, on["asks_are_tasks"])
	require.Contains(t, on["instructions"], "coral-board post --assign or task add --follow-up")
	read := call("GET", "")
	require.Equal(t, true, read["asks_are_tasks"], "read back")
	require.Contains(t, read["instructions"], "plain posts are for questions, decisions, heads-ups and status")
	off := call("PUT", `{"mode":"none"}`)
	require.Equal(t, false, off["asks_are_tasks"])
	require.NotContains(t, off["instructions"], "coral-board post --assign")
}
