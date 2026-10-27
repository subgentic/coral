package board

import (
	"context"
)

// goalRollupsByID is goalRollups for goals of different boards: one grouped read over the tasks linked to the page's goals, on the (board_id, goal_id, status) index (idx_board_tasks_goal_status leads with the board:
// a goal_id list alone would scan every task, Security's #7246 point 4).
func (s *Store) goalRollupsByID(ctx context.Context, goals []Goal) (map[int64]GoalRollup, error) {
	out := make(map[int64]GoalRollup, len(goals))
	if len(goals) == 0 {
		return out, nil
	}
	query, args := goalRollupsStatement(goals)
	var rows []struct {
		GoalID int64  `db:"goal_id"`
		Status string `db:"status"`
		N      int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		ru := out[r.GoalID]
		switch r.Status {
		case "completed", "skipped":
			ru.Done += r.N
		case "in_progress", "review_pending":
			ru.Active += r.N
		case "blocked":
			ru.Blocked += r.N
		default: // pending, draft
			ru.Queued += r.N
		}
		ru.Total += r.N
		out[r.GoalID] = ru
	}
	return out, nil
}

// goalRollupsStatement is the grouped read of the tasks linked to goals: the page's boards and goal ids, both in the WHERE so the index on (board_id, goal_id) serves it.
func goalRollupsStatement(goals []Goal) (string, []any) {
	var boards []any
	seen := map[string]bool{}
	for _, g := range goals {
		if !seen[g.BoardID] {
			seen[g.BoardID] = true
			boards = append(boards, g.BoardID)
		}
	}
	args := append([]any(nil), boards...)
	for _, g := range goals {
		args = append(args, g.ID)
	}
	return `SELECT goal_id, status, COUNT(*) AS n FROM board_tasks WHERE board_id IN (` + placeholders(len(boards)) + `) AND goal_id IN (` + placeholders(len(goals)) + `) GROUP BY goal_id, status`, args
}

// goalRollups counts the tasks of each of the goals of one board: the page's own goal ids, on the covering index, never every task the board has linked (#9584: that read grew with the closed goals' history, 4.75 ms of a 5.9 ms page).
func (s *Store) goalRollups(ctx context.Context, board string, ids []int64) (map[int64]GoalRollup, error) {
	goals := make([]Goal, len(ids))
	for i, id := range ids {
		goals[i] = Goal{ID: id, BoardID: board}
	}
	return s.goalRollupsByID(ctx, goals)
}
