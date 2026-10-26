package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7791: a task lists the tasks made from it (task add --follow-up), and its goal counts how many of them are still open.
func TestATaskListsItsFollowUpsAndItsGoalCountsTheOpenOnes(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "alpha", "Ship it")
	gid := g.ID

	parent, err := s.CreateTaskWithOpts(ctx, "alpha", "Build the importer", "", "high", "Orch", &CreateTaskOpts{GoalID: &gid}, "Dev A")
	require.NoError(t, err)
	assert.Empty(t, mustGetTask(t, s, parent.ID).FollowUps, "a task nobody followed up lists none")

	child := func(title string) *Task {
		c, err := s.CreateTaskWithOpts(ctx, "alpha", title, "", "medium", "Orch", &CreateTaskOpts{GoalID: &gid, Workflow: TaskWorkflow{ParentTaskID: parent.ID}}, "Dev A")
		require.NoError(t, err)
		return c
	}
	first, second := child("Fix the review notes"), child("Add the missing test")
	_, err = s.CreateTaskWithOpts(ctx, "alpha", "Unrelated", "", "medium", "Orch", &CreateTaskOpts{GoalID: &gid}, "Dev A")
	require.NoError(t, err)

	got := mustGetTask(t, s, parent.ID).FollowUps
	require.Len(t, got, 2, "the two made from it, not the unrelated one")
	assert.Equal(t, []int64{first.ID, second.ID}, []int64{got[0].ID, got[1].ID}, "oldest first")
	assert.Equal(t, "Fix the review notes", got[0].Title)
	assert.Equal(t, "Dev A", *got[0].AssignedTo)
	assert.Empty(t, mustGetTask(t, s, first.ID).FollowUps, "a follow-up lists the ones made from it, and nobody made one")

	gl, err := s.GetGoal(ctx, "alpha", gid)
	require.NoError(t, err)
	assert.Equal(t, 2, gl.FollowUpsOpen, "two follow-ups open on the goal")

	_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status = 'completed' WHERE id = ?", first.ID)
	require.NoError(t, err)
	gl, err = s.GetGoal(ctx, "alpha", gid)
	require.NoError(t, err)
	assert.Equal(t, 1, gl.FollowUpsOpen, "a finished one is not open")
	assert.Equal(t, "completed", mustGetTask(t, s, parent.ID).FollowUps[0].Status, "the parent still lists it, with its status")

	// the parent must be a task of this board
	_, err = s.CreateTaskWithOpts(ctx, "beta", "Elsewhere", "", "medium", "Orch", &CreateTaskOpts{Workflow: TaskWorkflow{ParentTaskID: parent.ID}})
	assert.Error(t, err, "another board's task is no parent")
}

func mustGetTask(t *testing.T, s *Store, id int64) *Task {
	t.Helper()
	task, err := s.GetTask(context.Background(), "alpha", id)
	require.NoError(t, err)
	return task
}
