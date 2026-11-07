package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14368 (found reading #14174's triggers): a task's goal-move rows are looked up by (board, task) on every status change of a goal-less task and in the departed-goal events; the primary key
// leads with (board, goal), so the lookup needs its own index. And a deleted task's move rows were never removed.
func TestAGoalMoveIsLookedUpByBoardAndTaskThroughAnIndex(t *testing.T) {
	s := testStore(t)
	rows, err := s.db.Query(`EXPLAIN QUERY PLAN SELECT 1 FROM board_goal_task_moves m WHERE m.board_id = 'team' AND m.task_id = 5`)
	require.NoError(t, err)
	defer rows.Close()
	var plan string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
		plan += detail + "\n"
	}
	assert.Contains(t, plan, "idx_board_goal_task_moves_task", "the lookup by (board, task) uses its own index: %s", plan)
	assert.Contains(t, plan, "task_id=?", "and searches on the task too, not only the board: %s", plan)
}

func TestDeletingATaskDeletesItsGoalMoveRowsAndStillTellsTheFormerGoal(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	from, to := newGoal(t, s, "team", "From"), newGoal(t, s, "team", "To")
	task, err := s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Lead", &CreateTaskOpts{GoalID: &from.ID})
	require.NoError(t, err)
	other, err := s.CreateTaskWithOpts(ctx, "team", "kept", "", "medium", "Lead", &CreateTaskOpts{GoalID: &from.ID})
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", task.ID, &to.ID))
	require.NoError(t, s.SetTaskGoal(ctx, "team", other.ID, &to.ID))
	count := func(id int64) (n int) {
		require.NoError(t, s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_goal_task_moves WHERE board_id='team' AND task_id=?`, id))
		return n
	}
	require.Positive(t, count(task.ID), "the move was recorded")
	var last int64
	require.NoError(t, s.reader().GetContext(ctx, &last, `SELECT MAX(id) FROM board_goal_events`))
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_tasks WHERE id=? AND board_id='team'`, task.ID)
	require.NoError(t, err)
	assert.Zero(t, count(task.ID), "a deleted task leaves no move rows")
	assert.Positive(t, count(other.ID), "another task's rows stay")
	var told int
	require.NoError(t, s.reader().GetContext(ctx, &told, `SELECT COUNT(*) FROM board_goal_events WHERE board_id='team' AND goal_id=? AND kind='task_unlinked' AND id>?`, from.ID, last))
	assert.Positive(t, told, "the goal the task came from is still told to refresh (the delete of the rows comes after the events that read them)")
}
