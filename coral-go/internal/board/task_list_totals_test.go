package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9113, #16686: TotalOpen counts only the active statuses (pending, in_progress, review_pending);
// blocked and draft are neither open nor done. Total counts everything.
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
	open, done, total, err := s.taskListTotals(ctx, "team")
	require.NoError(t, err)
	assert.Equal(t, 3, open, "pending, in_progress and review_pending")
	assert.Equal(t, 3, done, "two completed and one skipped")
	assert.Equal(t, 8, total, "all eight tasks of the board")
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{})
	require.NoError(t, err)
	assert.Equal(t, 3, page.TotalOpen)
	assert.Equal(t, 3, page.TotalCompleted)
	assert.Equal(t, 8, page.Total)
	for _, st := range []string{"open", "all", "completed"} {
		p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: st})
		require.NoError(t, err)
		assert.Equal(t, 3, p.TotalOpen, st)
		assert.Equal(t, 3, p.TotalCompleted, st)
		assert.Equal(t, 8, p.Total, st)
	}
	open, done, total, err = s.taskListTotals(ctx, "nobody")
	require.NoError(t, err)
	assert.Zero(t, open+done+total, "a board with no tasks")
}
