package board

import "context"

// A follow-up is a task made from another task of the board (task add --follow-up <id>, #7791, goal #21): the work that came out of it. It is recorded as the parent in the
// follow-up's workflow (parent_task_id, validated when the task is made to be a task of this board), and the parent lists its follow-ups when it is read.

// FollowUp is one follow-up of a task, as the parent lists it.
type FollowUp struct {
	ID         int64   `db:"id" json:"id"`
	Title      string  `db:"title" json:"title"`
	Status     string  `db:"status" json:"status"`
	AssignedTo *string `db:"assigned_to" json:"assigned_to"`
}

// followUpsOpenStatuses are the statuses a follow-up is done in: not open.
const followUpsDone = `('completed', 'skipped', 'cancelled')`

// FollowUps are the follow-ups of a task of the board, oldest first.
func (s *Store) FollowUps(ctx context.Context, board string, parentID int64) ([]FollowUp, error) {
	var out []FollowUp
	err := s.reader().SelectContext(ctx, &out, `SELECT t.id, t.title, t.status, t.assigned_to
		FROM task_workflows w JOIN board_tasks t ON t.id = w.task_id
		WHERE t.board_id = ? AND w.lst_parent > 0 AND w.lst_parent = ? ORDER BY t.id`, board, parentID)
	return out, err
}

// goalFollowUpsOpen counts the open follow-ups among a goal's tasks: the goal page says "N follow-ups open".
func (s *Store) goalFollowUpsOpen(ctx context.Context, board string, goalID int64) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.goal_id = ? AND t.status NOT IN `+followUpsDone+` AND w.lst_parent > 0`, board, goalID)
	return n, err
}
