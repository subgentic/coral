package board

import (
	"context"
	"encoding/json"
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

// #22112: an agent with one task in progress is on that task's goal; with two in progress it is on no single goal, and none is named (no guessing which).
func TestCurrentTaskNamesNoGoalWhenTwoTasksAreInProgress(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Dev", "Dev", "", nil, "")
	require.NoError(t, err)
	goalA, goalB := newGoal(t, s, "team", "Ship the beta"), newGoal(t, s, "team", "Fix the build")
	a, err := s.CreateTask(ctx, "team", "task a", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	b, err := s.CreateTask(ctx, "team", "task b", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", a.ID, &goalA.ID))
	require.NoError(t, s.SetTaskGoal(ctx, "team", b.ID, &goalB.ID))
	cur := func() CurrentTask {
		m, err := s.CurrentTasks(ctx)
		require.NoError(t, err)
		return m[CurrentTaskKey("team", "Dev")]
	}

	_, err = s.ClaimTask(ctx, "team", "Dev", a.ID)
	require.NoError(t, err)
	got := cur()
	assert.Equal(t, CurrentTask{ID: a.ID, Title: "task a", Status: "in_progress", GoalID: goalA.ID, GoalTitle: "Ship the beta"}, got, "one claimed task: its goal is named")

	// a second claim is refused while the first is held, so the second state is made directly (as a claim from before that rule, or by an Operator reassign, leaves it)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'in_progress', claimed_at = ? WHERE id = ? AND board_id = 'team'`, "2999-01-01T00:00:00Z", b.ID)
	require.NoError(t, err)
	got = cur()
	assert.Equal(t, CurrentTask{ID: b.ID, Title: "task b", Status: "in_progress"}, got, "two claimed tasks: the newest is the task, and no goal is named")
	raw, err := json.Marshal(got)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "goal_id")
	assert.NotContains(t, string(raw), "goal_title")

	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'completed' WHERE id = ? AND board_id = 'team'`, b.ID)
	require.NoError(t, err)
	assert.Equal(t, goalA.ID, cur().GoalID, "back to one claimed task: its goal is named again")
}
