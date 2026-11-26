package board

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21697: an owner marks a task waiting on a member or a condition. It is stored with the task (detail, show, the list), validated, listed for the health check, and cleared by the member's post or by the owner.
func TestATaskCanWaitOnAMemberAndClearsWhenTheyPost(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	task, err := s.CreateTask(ctx, "team", "Waits", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)

	got, err := s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Member: "Orchestrator", Reason: "need an order", SetBy: "Dev"})
	require.NoError(t, err)
	require.NotNil(t, got.Workflow.WaitingOn, "task detail carries it")
	assert.Equal(t, "Orchestrator", got.Workflow.WaitingOn.Target())
	assert.Equal(t, "Dev", got.Workflow.WaitingOn.Owner)
	assert.Equal(t, "in_progress", got.Status, "no status change")

	read, err := s.GetTask(ctx, "team", task.ID)
	require.NoError(t, err)
	require.NotNil(t, read.Workflow.WaitingOn, "and it is stored")

	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: "open"})
	require.NoError(t, err)
	require.Len(t, page.Tasks, 1)
	require.NotNil(t, page.Tasks[0].WaitingOn, "the list says it too")
	assert.Equal(t, "need an order", page.Tasks[0].WaitingOn.Reason)

	waits, err := s.ListTaskWaits(ctx, "team")
	require.NoError(t, err)
	require.Len(t, waits, 1)
	assert.Equal(t, task.ID, waits[0].TaskID)

	cleared, err := s.ClearWaitOnForPost(ctx, "team", task.ID, "Someone Else")
	require.NoError(t, err)
	assert.False(t, cleared, "another member's post does not end it")
	cleared, err = s.ClearWaitOnForPost(ctx, "team", task.ID, "orchestrator")
	require.NoError(t, err)
	assert.True(t, cleared, "the member waited on posted on the task: it clears")
	waits, _ = s.ListTaskWaits(ctx, "team")
	assert.Empty(t, waits)
	read, _ = s.GetTask(ctx, "team", task.ID)
	assert.Nil(t, read.Workflow.WaitingOn)
}

func TestAWaitOnACondition_ClearedByTheOwner_AndNotByAPost(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	task, err := s.CreateTask(ctx, "team", "Waits", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Condition: "CI on main", Reason: "release gate", SetBy: "Dev"})
	require.NoError(t, err)
	cleared, _ := s.ClearWaitOnForPost(ctx, "team", task.ID, "CI on main")
	assert.False(t, cleared, "a condition is not a member: no post ends it")
	_, cleared, err = s.ClearTaskWaitOn(ctx, "team", task.ID)
	require.NoError(t, err)
	assert.True(t, cleared)
	_, cleared, err = s.ClearTaskWaitOn(ctx, "team", task.ID)
	require.NoError(t, err)
	assert.False(t, cleared, "clearing a task that waits on no one says so")
}

func TestAWaitOnNeedsExactlyOneTargetAReasonAndOpenWork(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	task, err := s.CreateTask(ctx, "team", "Waits", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Member: "A", Condition: "B", Reason: "x"})
	assert.Error(t, err, "both")
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Reason: "x"})
	assert.Error(t, err, "neither")
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Member: "A"})
	assert.Error(t, err, "no reason")
	_, err = s.SetTaskWaitOn(ctx, "team", 9999, TaskWaitOn{Member: "A", Reason: "x"})
	assert.True(t, errors.Is(err, sql.ErrNoRows), "no such task")
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	doneMsg := "done"
	_, err = s.CompleteTask(ctx, "team", task.ID, "Dev", &doneMsg)
	require.NoError(t, err)
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Member: "A", Reason: "x"})
	assert.True(t, errors.Is(err, ErrNotWaitable), "a finished task waits on no one")
}

// A wait does not outlive a reassignment: it was the earlier owner's.
func TestAWaitIsNotListedAfterTheTaskChangesOwner(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	task, err := s.CreateTask(ctx, "team", "Waits", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.SetTaskWaitOn(ctx, "team", task.ID, TaskWaitOn{Member: "Orchestrator", Reason: "x", SetBy: "Dev"})
	require.NoError(t, err)
	_, err = s.ReassignTask(ctx, "team", task.ID, "Other")
	require.NoError(t, err)
	waits, err := s.ListTaskWaits(ctx, "team")
	require.NoError(t, err)
	assert.Empty(t, waits)
}
