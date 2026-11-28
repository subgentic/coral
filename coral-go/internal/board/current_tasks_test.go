package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21685: the task an agent is on is the one in progress, else the oldest queued one; a finished or reassigned task moves it; boards do not mix.
func TestCurrentTasksIsTheInProgressTaskElseTheOldestQueued(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, b := range []string{"alpha", "beta"} {
		_, err := s.Subscribe(ctx, b, "Dev", "Dev", "", nil, "")
		require.NoError(t, err)
	}
	cur := func() map[string]CurrentTask {
		m, err := s.CurrentTasks(ctx)
		require.NoError(t, err)
		return m
	}
	assert.Empty(t, cur(), "no task, nobody is on one")

	first, err := s.CreateTask(ctx, "alpha", "queued first", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "alpha", "queued second", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	got := cur()[CurrentTaskKey("alpha", "dev")] // the assignee is matched without case
	assert.Equal(t, CurrentTask{ID: first.ID, Title: "queued first", Status: "pending"}, got, "the oldest queued task")

	_, err = s.ClaimTask(ctx, "alpha", "Dev", second.ID)
	require.NoError(t, err)
	got = cur()[CurrentTaskKey("alpha", "Dev")]
	assert.Equal(t, CurrentTask{ID: second.ID, Title: "queued second", Status: "in_progress"}, got, "in progress beats an older queued task")

	_, err = s.CompleteTask(ctx, "alpha", second.ID, "Dev", nil)
	require.NoError(t, err)
	assert.Equal(t, first.ID, cur()[CurrentTaskKey("alpha", "Dev")].ID, "a finished task moves the agent to the next queued one")

	_, err = s.ReassignTask(ctx, "alpha", first.ID, "Someone Else")
	require.NoError(t, err)
	_, onIt := cur()[CurrentTaskKey("alpha", "Dev")]
	assert.False(t, onIt, "a reassigned task is no longer this agent's")
	assert.Equal(t, first.ID, cur()[CurrentTaskKey("alpha", "Someone Else")].ID)
	_, onBeta := cur()[CurrentTaskKey("beta", "Someone Else")]
	assert.False(t, onBeta, "a task on one board is not on another")
}

// #22093: an agent with two tasks in progress (a second claim is refused, so only a repair or an import makes it) has no goal guessed from the newest one, and says how many claims it has.
func TestCurrentTasksGuessNoGoalFromTwoClaims(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "alpha", "Dev", "Dev", "", nil, "")
	require.NoError(t, err)
	goal, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Checkout", CreatedBy: "Dev"})
	require.NoError(t, err)
	a, err := s.CreateTaskWithOpts(ctx, "alpha", "one", "", "medium", "Dev", &CreateTaskOpts{GoalID: &goal.ID})
	require.NoError(t, err)
	b, err := s.CreateTaskWithOpts(ctx, "alpha", "two", "", "medium", "Dev", &CreateTaskOpts{GoalID: &goal.ID})
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "alpha", "Dev", a.ID)
	require.NoError(t, err)
	cur, err := s.CurrentTasks(ctx)
	require.NoError(t, err)
	one := cur[CurrentTaskKey("alpha", "Dev")]
	assert.Equal(t, goal.ID, one.GoalID)
	assert.Equal(t, "Checkout", one.GoalTitle)
	assert.Zero(t, one.Claims)

	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'in_progress', assigned_to = 'Dev', claimed_at = ? WHERE id = ?`, nowUTC(), b.ID)
	require.NoError(t, err)
	cur, err = s.CurrentTasks(ctx)
	require.NoError(t, err)
	two := cur[CurrentTaskKey("alpha", "Dev")]
	assert.Equal(t, 2, two.Claims)
	assert.Zero(t, two.GoalID, "no goal is guessed")
	assert.Empty(t, two.GoalTitle)
}
