package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// goalRollupsAllLinked is goalRollups as it was before #9584: every linked task of the board grouped, then the page's goals picked out. It is the oracle of the page-scoped read.
func (s *Store) goalRollupsAllLinked(ctx context.Context, board string, ids []int64) (map[int64]GoalRollup, error) {
	out := make(map[int64]GoalRollup, len(ids))
	var rows []struct {
		GoalID int64  `db:"goal_id"`
		Status string `db:"status"`
		N      int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT goal_id, status, COUNT(*) AS n FROM board_tasks WHERE board_id = ? AND goal_id IS NOT NULL GROUP BY goal_id, status`, board); err != nil {
		return nil, err
	}
	want := map[int64]bool{}
	for _, id := range ids {
		want[id] = true
	}
	for _, r := range rows {
		if !want[r.GoalID] {
			continue
		}
		ru := out[r.GoalID]
		switch r.Status {
		case "completed", "skipped":
			ru.Done += r.N
		case "in_progress", "review_pending":
			ru.Active += r.N
		case "blocked":
			ru.Blocked += r.N
		default:
			ru.Queued += r.N
		}
		ru.Total += r.N
		out[r.GoalID] = ru
	}
	return out, nil
}

// The page-scoped rollup equals the all-linked one for every goal of a board with open and closed goals, tasks in every status, tasks with no goal, a goal with no tasks, and another board's tasks (one of them
// wrongly carrying this board's goal id: the board filter must keep it out).
func TestGoalRollupsOfThePageEqualTheAllLinkedRead(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_rollup.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	var open, closed []int64
	for i := 0; i < 6; i++ {
		g, err := s.CreateGoal(ctx, "team", GoalInput{Title: fmt.Sprintf("goal %d", i), CreatedBy: "Orchestrator"})
		require.NoError(t, err)
		if i < 3 {
			open = append(open, g.ID)
		} else {
			closed = append(closed, g.ID)
			_, err := s.db.ExecContext(ctx, `UPDATE board_goals SET state = 'done' WHERE id = ?`, g.ID)
			require.NoError(t, err)
		}
	}
	other, err := s.CreateGoal(ctx, "elsewhere", GoalInput{Title: "other board's goal", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	statuses := []string{"pending", "in_progress", "review_pending", "blocked", "draft", "completed", "skipped"}
	all := append(append([]int64{}, open...), closed...)
	for i := 0; i < 60; i++ {
		task, err := s.CreateTask(ctx, "team", fmt.Sprintf("t%d", i), "", "medium", "Orchestrator")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ?, goal_id = ? WHERE id = ?`, statuses[i%len(statuses)], nullableGoal(all, i), task.ID)
		require.NoError(t, err)
	}
	// another board's tasks, one of them carrying this board's first goal id by mistake, one its own goal
	for i := 0; i < 4; i++ {
		task, err := s.CreateTask(ctx, "elsewhere", fmt.Sprintf("e%d", i), "", "medium", "Orchestrator")
		require.NoError(t, err)
		gid := other.ID
		if i == 0 {
			gid = open[0]
		}
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ?, status = 'in_progress' WHERE id = ?`, gid, task.ID)
		require.NoError(t, err)
	}
	for name, ids := range map[string][]int64{"open goals": open, "closed goals": closed, "all": all, "one": all[:1], "a goal of another board": {other.ID}, "none": nil} {
		got, err := s.goalRollups(ctx, "team", ids)
		require.NoError(t, err)
		want, err := s.goalRollupsAllLinked(ctx, "team", ids)
		require.NoError(t, err)
		require.Equal(t, want, got, name)
	}
	got, err := s.goalRollups(ctx, "team", open[:1])
	require.NoError(t, err)
	require.Equal(t, 10, got[open[0]].Total, "ten of the 60 tasks are linked to the first goal; the other board's task carrying its id is not counted (board filter)")
}

// nullableGoal links 9 in 10 tasks: every tenth has no goal.
func nullableGoal(goals []int64, i int) any {
	if i%10 == 9 {
		return nil
	}
	return goals[i%len(goals)]
}
