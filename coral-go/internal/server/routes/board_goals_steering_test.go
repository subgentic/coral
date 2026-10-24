package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7271: closing a goal posts one board line with the state, the reason and the open-task count. (The answer to a blocked goal, #7271's other half, went with the goal decision: #7300.)
func steeringRig(t *testing.T) (call func(method, path string, body any) (int, map[string]any), h *BoardHandler, gid int64) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	_, err := h.bs.Subscribe(ctx, "team", "Lead", "Developer", "s-lead", nil, "")
	require.NoError(t, err)
	call = goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ship it", "driver": "Lead", "subscriber_id": "Orchestrator"})
	gid = int64(g["id"].(float64))
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "blocked", "blocked_on": "the operator", "subscriber_id": "Orchestrator"})
	require.Equal(t, 200, code, "%v", out)
	return call, h, gid
}

func messagesOf(t *testing.T, h *BoardHandler) []board.Message {
	t.Helper()
	msgs, err := h.bs.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	return msgs
}

func TestClosingAGoalPostsOneBoardLine(t *testing.T) {
	call, h, gid := steeringRig(t)
	_, err := h.bs.CreateTaskWithOpts(context.Background(), "team", "open task", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &gid})
	require.NoError(t, err)
	before := len(messagesOf(t, h))
	code, out := call("POST", "/api/board/team/goals/"+itoa(gid)+"/close", map[string]any{"reason": "shipped Friday", "state": "done", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	msgs := messagesOf(t, h)
	require.Len(t, msgs, before+1, "one line")
	m := msgs[len(msgs)-1]
	assert.Equal(t, "Operator", m.SubscriberID)
	assert.Contains(t, m.Content, "Ship it")
	assert.Contains(t, m.Content, "done", "the state")
	assert.Contains(t, m.Content, "shipped Friday", "the reason")
	assert.Contains(t, m.Content, "1 open task", "and how many tasks were still open")

	// Closing it again is refused and posts nothing.
	code, _ = call("POST", "/api/board/team/goals/"+itoa(gid)+"/close", map[string]any{"reason": "again", "subscriber_id": "Operator"})
	assert.Equal(t, 409, code)
	assert.Len(t, messagesOf(t, h), before+1)
}

// #7300 (the Operator's decision: a goal does not wait on a person; tasks and agents do): the goal decision, recommendation and if_silent and the answer are not fields any more. A write that names one is a
// 400 that names it, and a goal read carries none of them; a blocked goal keeps blocked_on as its plain reason.
func TestTheGoalDecisionFieldsAreRefusedAndNotRead(t *testing.T) {
	call, _, gid := steeringRig(t)
	for _, field := range []string{"decision", "recommendation", "if_silent", "answer"} {
		code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{field: "x", "subscriber_id": "Orchestrator"})
		assert.Equal(t, 400, code, "%s: %v", field, out)
		assert.Contains(t, out["error"], "unknown field "+field)
	}
	code, g := call("GET", "/api/board/team/goals/"+itoa(gid), nil)
	require.Equal(t, 200, code)
	for _, field := range []string{"decision", "recommendation", "if_silent", "answer"} {
		assert.NotContains(t, g, field, "a goal read carries no %s", field)
	}
	assert.Equal(t, "the operator", g["blocked_on"], "blocked keeps its plain reason")
	assert.Equal(t, "blocked", g["state"])
}
