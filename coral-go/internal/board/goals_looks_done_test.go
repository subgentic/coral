package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12081: "Goal #N looks done" said it had waited 4 minutes the moment it appeared, because the page counted from the goal's own time. The goal pages carry when the last task was completed.
func TestAGoalWithAllItsTasksDoneSaysWhenTheLastOneWasCompleted(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Looks done")
	open := newGoal(t, s, "team", "Still going")
	mk := func(goal *Goal) *Task {
		task, err := s.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal.ID})
		require.NoError(t, err)
		return task
	}
	a, b, c := mk(g), mk(g), mk(open)
	for i, task := range []*Task{a, b, c} {
		_, err := s.ClaimTask(ctx, "team", "Dev"+string(rune('A'+i)), task.ID)
		require.NoError(t, err)
	}
	lookup := func() map[int64]*string {
		page, err := s.AllGoalsPage(ctx, AllGoalsQuery{})
		require.NoError(t, err)
		out := map[int64]*string{}
		for _, x := range page.Goals {
			out[x.ID] = x.LooksDoneAt
		}
		return out
	}
	_, err := s.CompleteTask(ctx, "team", a.ID, "DevA", nil)
	require.NoError(t, err)
	assert.Nil(t, lookup()[g.ID], "a task is still open: it does not look done")
	_, err = s.CompleteTask(ctx, "team", b.ID, "DevB", nil)
	require.NoError(t, err)
	got := lookup()
	require.NotNil(t, got[g.ID], "every task is done: it says since when")
	var last string
	require.NoError(t, s.reader().GetContext(ctx, &last, `SELECT MAX(completed_at) FROM board_tasks WHERE board_id = 'team' AND goal_id = ?`, g.ID))
	assert.Equal(t, last, *got[g.ID], "the last completion, not the goal's own time")
	assert.Nil(t, got[open.ID], "another goal with an open task has none")
	one, err := s.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.Equal(t, GoalRollup{Done: 2, Total: 2}, one.Rollup)
}
