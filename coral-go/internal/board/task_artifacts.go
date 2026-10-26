package board

import (
	"context"
	"strings"
)

// An artifact an agent uploads is linked to the task it is working on (#7739). The link itself is kept on the upload's record (internal/server/routes), where an upload's other facts are; these
// are the two reads that link and its lists need from the board.

// InProgressTaskIDsOf is the ids of the tasks the member has in progress and not parked on the board (a parked one is set aside, #7819), at most two: one is the task its uploads link to, and a second means the board holds what it should not
// (a member works on one task at a time), so the caller links none.
func (s *Store) InProgressTaskIDsOf(ctx context.Context, project, member string) ([]int64, error) {
	var ids []int64
	err := s.reader().SelectContext(ctx, &ids,
		`SELECT id FROM board_tasks WHERE board_id = ? AND assigned_to = ? AND `+holdsSlotSQL+` ORDER BY id LIMIT 2`, project, member)
	return ids, err
}

// TaskTitles is the titles of the board's tasks with these ids: a task that is not on this board (or is gone) is not in the answer.
func (s *Store) TaskTitles(ctx context.Context, project string, ids []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, project)
	for _, id := range ids {
		args = append(args, id)
	}
	var rows []struct {
		ID    int64  `db:"id"`
		Title string `db:"title"`
	}
	q := `SELECT id, title FROM board_tasks WHERE board_id = ? AND id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `)`
	if err := s.reader().SelectContext(ctx, &rows, q, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r.Title
	}
	return out, nil
}

// TaskGoal is the goal a task belongs to: its number and title.
type TaskGoal struct {
	ID    int64
	Title string
}

// TaskGoals maps each of the project's tasks in ids that belongs to a goal to that goal (a task with none is not in the map): what the Artifacts list says of an artifact's goal (#8575).
func (s *Store) TaskGoals(ctx context.Context, project string, ids []int64) (map[int64]TaskGoal, error) {
	out := make(map[int64]TaskGoal, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, project)
	for _, id := range ids {
		args = append(args, id)
	}
	var rows []struct {
		TaskID int64  `db:"task_id"`
		GoalID int64  `db:"goal_id"`
		Title  string `db:"title"`
	}
	q := `SELECT t.id AS task_id, g.id AS goal_id, g.title AS title FROM board_tasks t JOIN board_goals g ON g.id = t.goal_id
		WHERE t.board_id = ? AND t.id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `)`
	if err := s.reader().SelectContext(ctx, &rows, q, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.TaskID] = TaskGoal{ID: r.GoalID, Title: r.Title}
	}
	return out, nil
}
