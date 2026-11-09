package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func readBody(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

// The Operator's assignment limit (#14862): an agent with more than 2 waiting tasks is not given another without --force; the refusal names the less loaded agents, force assigns and says so on the board.
func TestAssigningPastTheLimitIsRefusedWithTheLessLoadedAgentsAndForceOverrides(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "team", "Orchestrator")
	base := server.URL + "/api/board/team"
	for _, n := range []string{"Dev A", "Dev B", "Dev C"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": n, "job_title": "Developer " + n[len(n)-1:], "session_name": "claude-" + strings.ReplaceAll(n, " ", "-")}).Body.Close()
	}
	add := func(who string, extra map[string]any) *http.Response {
		body := map[string]any{"title": "work", "created_by": "Orchestrator", "assigned_to": who}
		for k, v := range extra {
			body[k] = v
		}
		return postJSON(t, base+"/tasks", body)
	}
	for i := 0; i < 3; i++ {
		resp := add("Dev A", nil)
		require.Equal(t, http.StatusCreated, resp.StatusCode, "up to 3 may be given: the refusal is past 2 waiting")
		resp.Body.Close()
	}
	add("Dev B", nil).Body.Close()
	resp := add("Dev A", nil)
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	out := readBody(t, resp)
	assert.Equal(t, "assignee_overloaded", out["code"])
	msg := out["error"].(string)
	assert.Contains(t, msg, "Dev A has 3 waiting (the limit is 2)")
	assert.Less(t, strings.Index(msg, "Dev C"), strings.Index(msg, "Dev B"), "the less loaded first: %s", msg)
	assert.Contains(t, msg, "Dev C (0 waiting, awake, Developer C)")
	assert.Contains(t, msg, "--force")
	options := out["options"].([]any)
	assert.Equal(t, "Dev C", options[0].(map[string]any)["name"])
	assert.NotContains(t, msg, "Dev A (", "the overloaded agent is not offered")

	// force assigns anyway, and the board says who
	resp = add("Dev A", map[string]any{"force": true})
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	created := readBody(t, resp)
	require.Eventually(t, func() bool {
		msgs, _ := handler.bs.ListMessages(t.Context(), "team", 50, 0, 0)
		for _, m := range msgs {
			if strings.Contains(m.Content, "past the limit (3 waiting) by Orchestrator with --force") && strings.Contains(m.Content, "Dev A") {
				return true
			}
		}
		return false
	}, 2*time.Second, 20*time.Millisecond, "a forced assignment is recorded on the board with who forced it")
	_ = created

	// reassign takes the same rule, and a task already on the agent is not a new assignment to it
	resp = add("Dev C", nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	taskC := int(readBody(t, resp)["id"].(float64))
	resp = postJSON(t, base+"/tasks/"+itoa(int64(taskC))+"/reassign", map[string]any{"subscriber_id": "Orchestrator", "assignee": "Dev A"})
	require.Equal(t, http.StatusConflict, resp.StatusCode, "reassigning to a loaded agent is refused too")
	assert.Equal(t, "assignee_overloaded", readBody(t, resp)["code"])
	resp = postJSON(t, base+"/tasks/"+itoa(int64(taskC))+"/reassign", map[string]any{"subscriber_id": "Orchestrator", "assignee": "Dev A", "force": true})
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp.Body.Close()
	resp = postJSON(t, base+"/tasks/"+itoa(int64(taskC))+"/reassign", map[string]any{"subscriber_id": "Orchestrator", "assignee": "Dev A"})
	assert.Equal(t, http.StatusOK, resp.StatusCode, "already Dev A's: nothing new is given")
	resp.Body.Close()
}

func TestTheLimitIsTheTeamsOwnAndZeroTurnsItOff(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "team", "Orchestrator")
	base := server.URL + "/api/board/team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev A", "job_title": "Developer", "session_name": "claude-a"}).Body.Close()
	add := func(by string) int {
		resp := postJSON(t, base+"/tasks", map[string]any{"title": "work", "created_by": by, "assigned_to": "Dev A"})
		defer resp.Body.Close()
		return resp.StatusCode
	}
	for i := 0; i < 3; i++ {
		require.Equal(t, http.StatusCreated, add("Orchestrator"))
	}
	require.Equal(t, http.StatusConflict, add("Orchestrator"))
	s := board.DefaultHealthSettings()
	s.AssignLimit = 0
	require.NoError(t, handler.bs.SetHealthSettings(t.Context(), "team", s))
	assert.Equal(t, http.StatusCreated, add("Orchestrator"), "0 is no limit")
	s.AssignLimit = 10
	require.NoError(t, handler.bs.SetHealthSettings(t.Context(), "team", s))
	assert.Equal(t, http.StatusCreated, add("Orchestrator"), "a higher limit lets more through")
}
