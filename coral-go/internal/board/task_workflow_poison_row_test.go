package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9512: one task_workflows row whose data is not JSON (a hand edit, a damaged page) must not take the whole board's status down: json_extract raises "malformed JSON" for the row, and
// TasksUnderReview, read on every /api/board/{b}/status, was the one query of the status that failed with it (a 500 for the board). A damaged row counts as having no completion review.
func TestTasksUnderReviewSurvivesAMalformedWorkflowRow(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	damaged, err := s.CreateTask(ctx, "b", "damaged workflow", "", "medium", "lead")
	require.NoError(t, err)
	reviewed, err := s.CreateTask(ctx, "b", "under review", "", "medium", "lead")
	require.NoError(t, err)
	for _, id := range []int64{damaged.ID, reviewed.ID} {
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'in_progress', assigned_to = 'dev' WHERE id = ?`, id)
		require.NoError(t, err)
	}
	_, err = s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_workflows (task_id, data) VALUES (?, ?)`, damaged.ID, "not json {")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_workflows (task_id, data) VALUES (?, ?)`, reviewed.ID, `{"completion_review": {"candidate": "x"}}`)
	require.NoError(t, err)
	got, err := s.TasksUnderReview(ctx, "b")
	require.NoError(t, err, "a malformed workflow row is one task's problem, not the board's")
	assert.Equal(t, map[int64]string{reviewed.ID: "dev"}, got, "the task with a completion review is under review; the damaged one is not")
}
