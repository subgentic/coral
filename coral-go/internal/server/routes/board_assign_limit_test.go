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

func subscribeAgents(t *testing.T, base string, names ...string) {
	t.Helper()
	for _, n := range names {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": n, "job_title": "Developer", "session_name": "claude-" + strings.ReplaceAll(n, " ", "-")}).Body.Close()
	}
}

// QA's L8 (#14948): editing a task's assignee is an assignment too: past the limit it answers 409 with the options, and --force goes through and is recorded on the board.
func TestEditingATasksAssigneePastTheLimitIsRefusedAndForceIsRecorded(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "team", "Orchestrator")
	base := server.URL + "/api/board/team"
	subscribeAgents(t, base, "Dev A", "Dev B")
	for i := 0; i < 3; i++ {
		resp := postJSON(t, base+"/tasks", map[string]any{"title": "work", "created_by": "Orchestrator", "assigned_to": "Dev A"})
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		resp.Body.Close()
	}
	resp := postJSON(t, base+"/tasks", map[string]any{"title": "for B", "created_by": "Orchestrator", "assigned_to": "Dev B"})
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	id := int64(readBody(t, resp)["id"].(float64))

	resp = patchJSON(t, base+"/tasks/"+itoa(id), map[string]any{"subscriber_id": "Orchestrator", "assigned_to": "Dev A"})
	require.Equal(t, http.StatusConflict, resp.StatusCode, "an edit of the assignee past the limit is refused")
	out := readBody(t, resp)
	assert.Equal(t, "assignee_overloaded", out["code"])
	assert.Contains(t, out["error"], "Dev A has 3 waiting")
	task, err := handler.bs.GetTask(t.Context(), "team", id)
	require.NoError(t, err)
	assert.Equal(t, "Dev B", *task.AssignedTo, "nothing was changed")

	resp = patchJSON(t, base+"/tasks/"+itoa(id), map[string]any{"subscriber_id": "Orchestrator", "assigned_to": "Dev A", "force": true})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	resp.Body.Close()
	task, _ = handler.bs.GetTask(t.Context(), "team", id)
	assert.Equal(t, "Dev A", *task.AssignedTo)
	require.Eventually(t, func() bool {
		msgs, _ := handler.bs.ListMessages(t.Context(), "team", 50, 0, 0)
		for _, m := range msgs {
			if strings.Contains(m.Content, "[Task #"+itoa(id)+" assigned to Dev A past the limit (3 waiting) by Orchestrator with --force]") {
				return true
			}
		}
		return false
	}, 2*time.Second, 20*time.Millisecond, "a forced edit is recorded on the board with who forced it")
}

// QA's L3 (#14948): an agent that creates a task for itself while over the limit is not refused (its own plan is not an assignment to it); someone else assigning to the same agent is.
func TestAnAgentCreatingATaskForItselfOverTheLimitIsNotRefused(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "team", "Orchestrator")
	base := server.URL + "/api/board/team"
	_, err := handler.bs.Subscribe(t.Context(), "team", "Lead A", "Orchestrator", "claude-lead-a", nil, "all") // a planner with a session of its own: it may create tasks, and be assigned them
	require.NoError(t, err)
	for i := 0; i < 3; i++ {
		resp := postJSON(t, base+"/tasks", map[string]any{"title": "work", "created_by": "Orchestrator", "assigned_to": "Lead A"})
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		resp.Body.Close()
	}
	resp := postJSON(t, base+"/tasks", map[string]any{"title": "by someone else", "created_by": "Orchestrator", "assigned_to": "Lead A"})
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "another's assignment past the limit is refused")
	resp.Body.Close()
	resp = postJSON(t, base+"/tasks", map[string]any{"title": "my own plan", "created_by": "Lead A", "assigned_to": "Lead A"})
	assert.Equal(t, http.StatusCreated, resp.StatusCode, "its own task for itself is not")
	resp.Body.Close()
}

// QA's L7 (#14948): the refusal names at most 5 less loaded agents, the least loaded first.
func TestTheRefusalNamesAtMostFiveLessLoadedAgents(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "team", "Orchestrator")
	base := server.URL + "/api/board/team"
	subscribeAgents(t, base, "Dev A", "Dev 1", "Dev 2", "Dev 3", "Dev 4", "Dev 5", "Dev 6", "Dev 7")
	for i := 0; i < 3; i++ {
		resp := postJSON(t, base+"/tasks", map[string]any{"title": "work", "created_by": "Orchestrator", "assigned_to": "Dev A"})
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		resp.Body.Close()
	}
	for _, n := range []string{"Dev 1", "Dev 2"} { // two of the seven have one waiting each: they are the last of the options
		resp := postJSON(t, base+"/tasks", map[string]any{"title": "work", "created_by": "Orchestrator", "assigned_to": n})
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		resp.Body.Close()
	}
	resp := postJSON(t, base+"/tasks", map[string]any{"title": "more", "created_by": "Orchestrator", "assigned_to": "Dev A"})
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	out := readBody(t, resp)
	options := out["options"].([]any)
	require.Len(t, options, 5, "seven agents are less loaded; five are named")
	for _, o := range options {
		assert.EqualValues(t, 0, o.(map[string]any)["waiting"], "the least loaded come first: the two with one waiting are cut")
	}
	assert.NotContains(t, out["error"], "Dev 1 (")
	assert.NotContains(t, out["error"], "Dev 2 (")
}
