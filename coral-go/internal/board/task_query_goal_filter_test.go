package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7782: the task query filters by goal: goal_id=N the tasks that serve that goal, goal_id=none those that serve none, goal_id=N,none both; it composes with the other filters; a bad value is named.
func TestTaskQueryGoalIDFilter(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a, b := newGoal(t, s, "team", "Goal A"), newGoal(t, s, "team", "Goal B")
	mk := func(title, priority string, goal *int64) int64 {
		t.Helper()
		task, err := s.CreateTask(ctx, "team", title, "", priority, "Lead")
		require.NoError(t, err)
		if goal != nil {
			require.NoError(t, s.SetTaskGoal(ctx, "team", task.ID, goal))
		}
		return task.ID
	}
	inA, inAHigh, inB, bare := mk("in a", "medium", &a.ID), mk("in a high", "high", &a.ID), mk("in b", "medium", &b.ID), mk("bare", "medium", nil)
	ids := func(p TaskQueryParams) []int64 {
		t.Helper()
		q, err := ParseTaskQuery(p)
		require.NoError(t, err)
		res, err := s.QueryTasks(ctx, q)
		require.NoError(t, err)
		var out []int64
		for _, m := range res.Tasks {
			out = append(out, m["id"].(int64))
		}
		return out
	}
	one := func(n int64) string { return itoaGoal(int(n)) }

	assert.ElementsMatch(t, []int64{inA, inAHigh}, ids(TaskQueryParams{Fields: []string{"id"}, GoalID: []string{one(a.ID)}}))
	assert.ElementsMatch(t, []int64{bare}, ids(TaskQueryParams{Fields: []string{"id"}, GoalID: []string{"none"}}))
	assert.ElementsMatch(t, []int64{inB, bare}, ids(TaskQueryParams{Fields: []string{"id"}, GoalID: []string{one(b.ID) + ",none"}}))
	assert.ElementsMatch(t, []int64{inAHigh}, ids(TaskQueryParams{Fields: []string{"id"}, GoalID: []string{one(a.ID)}, Priority: []string{"high"}}), "it composes with another filter")
	assert.ElementsMatch(t, []int64{inA, inAHigh, inB, bare}, ids(TaskQueryParams{Fields: []string{"id"}}), "no goal_id: every task")

	// a goal id that is 0 in the column counts as no goal, as a null does
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = 0 WHERE id = ?`, inB)
	require.NoError(t, err)
	assert.ElementsMatch(t, []int64{inB, bare}, ids(TaskQueryParams{Fields: []string{"id"}, GoalID: []string{"none"}}))

	for _, bad := range []string{"0", "-3", "abc", "1.5", "none,", "NONE", "01"} {
		_, perr := ParseTaskQuery(TaskQueryParams{GoalID: []string{bad}})
		assert.ErrorIs(t, perr, ErrTaskQuery, bad)
	}
}
