package board

import "context"

// ClaimedTaskAnywhere is the most important task member has claimed and is working on (in progress) on ANY board, with the board it is on and its priority (critical, high, medium or low): what the resource
// queue (pkg/resourcequeue, #13613) ranks an agent's claim by. ok is false when the member has no task in progress. The most important wins; the oldest task breaks a tie.
func (s *Store) ClaimedTaskAnywhere(ctx context.Context, member string) (taskID int64, project, priority string, ok bool, err error) {
	var rows []struct {
		ID       int64  `db:"id"`
		BoardID  string `db:"board_id"`
		Priority string `db:"priority"`
	}
	if err = s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, priority FROM board_tasks WHERE assigned_to = ? COLLATE NOCASE AND status = 'in_progress'
		ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, id ASC LIMIT 1`, member); err != nil {
		return 0, "", "", false, err
	}
	if len(rows) == 0 {
		return 0, "", "", false, nil
	}
	return rows[0].ID, rows[0].BoardID, rows[0].Priority, true, nil
}
