package board

import (
	"context"
	"time"
)

// FinishedSince is how many of the board's tasks were completed after since: the work that is approved and waiting to land (#8942). Review tasks are not work.
func (s *Store) FinishedSince(ctx context.Context, project string, since time.Time) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status = 'completed' AND t.completed_at > ? AND COALESCE(json_extract(w.data, '$.review_of'), 0) = 0`,
		project, since.UTC().Format(time.RFC3339))
	return n, err
}
