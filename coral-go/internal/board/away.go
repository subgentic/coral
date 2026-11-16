package board

import (
	"context"
	"time"
)

// Away is what happened on this computer's boards since a time, as counts only: no titles, no names (#17537).
type Away struct {
	TasksDone int `json:"tasks_done"`
	GoalsDone int `json:"goals_done"`
}

// AwayCounts counts the tasks completed and the goals closed as done, on every board, at or after since. A review task (one made for a reviewer) is not a finished piece of work and is left out.
func (s *Store) AwayCounts(ctx context.Context, since time.Time) (Away, error) {
	var a Away
	at := since.UTC().Format(time.RFC3339)
	if err := s.reader().GetContext(ctx, &a.TasksDone, `SELECT COUNT(*) FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.status = 'completed' AND t.completed_at >= ? AND COALESCE(json_extract(w.data, '$.review_of'), 0) = 0`, at); err != nil {
		return a, err
	}
	err := s.reader().GetContext(ctx, &a.GoalsDone, `SELECT COUNT(*) FROM board_goals WHERE state = 'done' AND closed_at >= ?`, at)
	return a, err
}
