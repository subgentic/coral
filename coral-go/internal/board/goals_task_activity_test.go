package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A goal's Updated time counts its agents' work (#17887, walk 76): a task made, claimed or finished under the goal is newer than the goal's own last edit, so the goal says it was just worked on.
// The one goal read, the board's list and the all-boards page agree; a goal with no tasks keeps its own time, and another goal's tasks do not move it.
func TestAGoalsUpdatedTimeCountsItsTasksActivity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Worked on")
	quiet := newGoal(t, s, "team", "Quiet")
	other := newGoal(t, s, "team", "Other")
	old := "2020-01-01T00:00:00Z"
	_, err := s.Writer().ExecContext(ctx, `UPDATE board_goals SET updated_at = ? WHERE board_id = 'team'`, old)
	require.NoError(t, err)
	task, err := s.CreateTaskWithOpts(ctx, "team", "do it", "", "medium", "Lead", &CreateTaskOpts{GoalID: &other.ID})
	require.NoError(t, err)
	require.NotNil(t, task)
	_, err = s.CreateTaskWithOpts(ctx, "team", "mine", "", "medium", "Lead", &CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)

	got, err := s.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.Greater(t, got.UpdatedAt, old, "a task made under the goal is newer than the goal's own last edit")
	q, err := s.GetGoal(ctx, "team", quiet.ID)
	require.NoError(t, err)
	assert.Equal(t, old, q.UpdatedAt, "a goal with no tasks keeps its own time")

	list, err := s.ListGoals(ctx, "team", GoalListQuery{})
	require.NoError(t, err)
	byID := map[int64]string{}
	for _, x := range list {
		byID[x.ID] = x.UpdatedAt
	}
	assert.Equal(t, got.UpdatedAt, byID[g.ID], "the list says what the goal's own read says")
	assert.Equal(t, old, byID[quiet.ID])

	all, err := s.AllGoalsPage(ctx, AllGoalsQuery{})
	require.NoError(t, err)
	for _, x := range all.Goals {
		if x.ID == g.ID {
			assert.Equal(t, got.UpdatedAt, x.UpdatedAt, "and so does the all-boards page")
		}
		if x.ID == quiet.ID {
			assert.Equal(t, old, x.UpdatedAt)
		}
	}
}
