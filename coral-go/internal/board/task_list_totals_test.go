package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9113: the list's two totals are one grouped count: open is every status that is not done, done is completed and skipped, and another board's tasks are not counted.
func TestTaskListTotalsCountEveryStatusOfTheBoardAndNoOther(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for _, st := range []string{"pending", "in_progress", "blocked", "draft", "review_pending", "completed", "skipped", "completed"} {
		task, err := s.CreateTask(ctx, "team", "T "+st, "", "medium", "lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ? WHERE id = ?`, st, task.ID)
		require.NoError(t, err)
	}
	_, err := s.CreateTask(ctx, "other", "Elsewhere", "", "medium", "lead")
	require.NoError(t, err)
	open, done, err := s.taskListTotals(ctx, "team")
	require.NoError(t, err)
	assert.Equal(t, 5, open, "pending, in_progress, blocked, draft and review_pending")
	assert.Equal(t, 3, done, "two completed and one skipped")
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{})
	require.NoError(t, err)
	assert.Equal(t, 5, page.TotalOpen)
	assert.Equal(t, 3, page.TotalCompleted)
	for _, st := range []string{"open", "all", "completed"} {
		p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: st})
		require.NoError(t, err)
		assert.Equal(t, 5, p.TotalOpen, st)
		assert.Equal(t, 3, p.TotalCompleted, st)
	}
	open, done, err = s.taskListTotals(ctx, "nobody")
	require.NoError(t, err)
	assert.Zero(t, open+done, "a board with no tasks")
}
