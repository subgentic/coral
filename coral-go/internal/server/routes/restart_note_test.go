package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #17411 (walk 68): after Stop then Restart the agent posted a new introduction and waited, though it owned a task, and used its old name. The restart's note names it, lists its tasks, and says not to introduce itself.
func TestARestartedAgentIsToldItsNameAndItsTasks(t *testing.T) {
	_, bh := setupBoardTestServer(t)
	ctx := context.Background()
	h := &SessionsHandler{bs: bh.bs}
	_, err := bh.bs.CreateTask(ctx, "team-a", "Fix the login page", "", "high", "Lead", "Bug-Hunter")
	require.NoError(t, err)
	_, err = bh.bs.CreateTask(ctx, "team-a", "Someone else's task", "", "high", "Lead", "Other")
	require.NoError(t, err)
	p := &restartPlan{board: "team-a", displayName: "Bug Hunter", subscription: &board.Subscriber{Project: "team-a", SubscriberID: "Bug-Hunter"}}
	note := h.restartNote(ctx, p)
	assert.Contains(t, note, "Bug Hunter", "its current name")
	assert.Contains(t, note, "Do not post a new introduction")
	assert.Contains(t, note, "Fix the login page", "the task it holds")
	assert.NotContains(t, note, "Someone else's task")
	assert.Equal(t, "", (&SessionsHandler{}).restartNote(ctx, p), "no board, no note")
	assert.Contains(t, restartNoteText("Dev", "Dev", nil), "You hold no task now")
}
