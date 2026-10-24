package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7345 (Frontend's #7302 gap): the machine-wide task query takes goal_id and goal_title in fields=, so the Inbox can ask for them. goal_title is not a column:
// it is filled from the task's own board's goals, as on the whole rows, and a field list that does not name it never reads the goals.
func TestTaskQueryFieldsGoalIDAndGoalTitle(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Ship the beta")
	other := newGoal(t, s, "other", "Elsewhere")
	mk := func(board, title string, goal *int64) int64 {
		t.Helper()
		task, err := s.CreateTask(ctx, board, title, "", "medium", "Lead")
		require.NoError(t, err)
		if goal != nil {
			require.NoError(t, s.SetTaskGoal(ctx, board, task.ID, goal))
		}
		return task.ID
	}
	linked, bare, elsewhere := mk("team", "linked", &g.ID), mk("team", "bare", nil), mk("other", "elsewhere", &other.ID)
	// a goal id that exists on another board must not title a task of this one
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ? WHERE id = ?`, other.ID, bare)
	require.NoError(t, err)

	rows := func(fields ...string) map[int64]map[string]any {
		t.Helper()
		q, err := ParseTaskQuery(TaskQueryParams{Fields: fields})
		require.NoError(t, err)
		res, err := s.QueryTasks(ctx, q)
		require.NoError(t, err)
		out := map[int64]map[string]any{}
		for _, m := range res.Tasks {
			out[m["id"].(int64)] = m
		}
		return out
	}

	got := rows("id", "goal_id", "goal_title")
	assert.Equal(t, g.ID, got[linked]["goal_id"])
	assert.Equal(t, "Ship the beta", got[linked]["goal_title"])
	assert.Equal(t, other.ID, got[elsewhere]["goal_id"])
	assert.Equal(t, "Elsewhere", got[elsewhere]["goal_title"])
	assert.NotContains(t, got[bare], "goal_title", "a goal of another board gives no title")
	assert.NotContains(t, got[bare], "_goal", "the hidden column is never in an answer")

	titleOnly := rows("id", "goal_title")
	assert.Equal(t, "Ship the beta", titleOnly[linked]["goal_title"])
	assert.NotContains(t, titleOnly[linked], "goal_id", "goal_id only when asked for")
	idOnly := rows("id", "goal_id")
	assert.NotContains(t, idOnly[linked], "goal_title")

	// a task with no goal: goal_id is null (named, so there, like the other nullable fields) and there is no title
	nogoal := newTaskNoGoal(t, s, ctx)
	assert.Contains(t, rows("id", "goal_id", "goal_title")[nogoal], "goal_id")
	assert.Nil(t, rows("id", "goal_id", "goal_title")[nogoal]["goal_id"])
	assert.NotContains(t, rows("id", "goal_id", "goal_title")[nogoal], "goal_title")

	// the summary set does not grow
	assert.NotContains(t, rows("summary")[linked], "goal_title")
	assert.NotContains(t, TaskQuerySummaryFields, "goal_id")

	// by id, in the order asked (the rows are reordered, and so must their goals be)
	q, err := ParseTaskQuery(TaskQueryParams{Fields: []string{"id", "goal_title"}, ID: []string{itoaGoal(int(elsewhere)), itoaGoal(int(linked))}})
	require.NoError(t, err)
	res, err := s.QueryTasks(ctx, q)
	require.NoError(t, err)
	require.Len(t, res.Tasks, 2)
	assert.Equal(t, elsewhere, res.Tasks[0]["id"])
	assert.Equal(t, "Elsewhere", res.Tasks[0]["goal_title"])
	assert.Equal(t, "Ship the beta", res.Tasks[1]["goal_title"])

	// by text too (the other path)
	q, err = ParseTaskQuery(TaskQueryParams{Fields: []string{"id", "goal_title"}, Q: []string{"linked"}})
	require.NoError(t, err)
	res, err = s.QueryTasks(ctx, q)
	require.NoError(t, err)
	require.Len(t, res.Tasks, 1)
	assert.Equal(t, "Ship the beta", res.Tasks[0]["goal_title"])
	assert.NotContains(t, res.Tasks[0], "_goal")
}

func newTaskNoGoal(t *testing.T, s *Store, ctx context.Context) int64 {
	t.Helper()
	task, err := s.CreateTask(ctx, "team", "no goal at all", "", "medium", "Lead")
	require.NoError(t, err)
	return task.ID
}
