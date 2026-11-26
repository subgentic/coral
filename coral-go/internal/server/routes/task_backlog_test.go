package routes

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func anyMessageContaining(t *testing.T, base, sub string) bool {
	t.Helper()
	for _, c := range boardMessageContents(t, base) {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

// #21701: a task added with later is the assignee's backlog: its assignment is announced quietly (no @mention of the assignee, no broadcast), no terminal gets a nudge, a bare claim does not
// offer it, and the assignee claims it by number, which promotes it.
func TestATaskAddedLaterIsBacklogAndWakesNobody(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "myproject", "Orchestrator")
	base := server.URL + "/api/board/myproject"
	terminal := newMockTerminal()
	const sess = "claude-00000003-3864-4864-8864-000000000003"
	terminal.addSession(sess, "/tmp/a")
	handler.SetTerminal(terminal)
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Backend Dev", "job_title": "Backend Dev", "session_name": sess}).Body.Close()

	resp := postJSON(t, base+"/tasks", map[string]any{"title": "Someday work", "created_by": "Orchestrator", "assigned_to": "Backend Dev", "later": true})
	resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.Eventually(t, func() bool { return anyMessageContaining(t, base, "Someday work") }, 5*time.Second, 25*time.Millisecond)
	assert.False(t, messageStartingWith(t, base, "@Backend Dev"), "the assignee is not told it is theirs to start")
	assert.False(t, anyMessageContaining(t, base, "@notify-all"))
	assert.Empty(t, terminal.sentTo(sess), "nothing was typed into the assignee's terminal")

	task, err := handler.bs.GetTask(t.Context(), "myproject", 1)
	require.NoError(t, err)
	assert.True(t, task.InBacklog())
	assert.Equal(t, "pending", task.Status)

	resp = postJSON(t, base+"/tasks/claim", map[string]string{"subscriber_id": "Backend Dev"})
	resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode, "a bare claim is not offered backlog")

	resp = postJSON(t, base+"/tasks/claim", map[string]any{"subscriber_id": "Backend Dev", "task_id": 1})
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, "claimed by number")
	task, err = handler.bs.GetTask(t.Context(), "myproject", 1)
	require.NoError(t, err)
	assert.Equal(t, "in_progress", task.Status)
	assert.False(t, task.InBacklog(), "claiming promotes it")
}

// #21701: reassign with later puts the task in the backlog; unassigning (no assignee) wakes nobody: no broadcast, only the Orchestrator is tagged.
func TestUnassigningWakesNobodyAndReassignLaterIsBacklog(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "myproject", "Orchestrator")
	base := server.URL + "/api/board/myproject"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Backend Dev", "job_title": "Backend Dev"}).Body.Close()
	postJSON(t, base+"/tasks", map[string]string{"title": "First", "created_by": "Orchestrator", "assigned_to": "Backend Dev"}).Body.Close()
	postJSON(t, base+"/tasks", map[string]string{"title": "Second", "created_by": "Orchestrator"}).Body.Close()

	resp := postJSON(t, base+"/tasks/2/reassign", map[string]any{"subscriber_id": "Operator", "assignee": "Backend Dev", "later": true})
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	task, err := handler.bs.GetTask(t.Context(), "myproject", 2)
	require.NoError(t, err)
	assert.True(t, task.InBacklog())

	resp = postJSON(t, base+"/tasks/1/reassign", map[string]any{"subscriber_id": "Operator", "assignee": ""})
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool { return anyMessageContaining(t, base, "[Task #1 reassigned — now unassigned]") }, 5*time.Second, 25*time.Millisecond)
	for _, c := range boardMessageContents(t, base) {
		if strings.Contains(c, "[Task #1 reassigned — now unassigned]") {
			assert.False(t, strings.Contains(strings.ToLower(c), "@notify-all") || strings.Contains(strings.ToLower(c), "@all"), "no broadcast: %q", c)
			assert.True(t, strings.HasPrefix(c, "@Orchestrator "), "only the Orchestrator is told: %q", c)
		}
	}
}
