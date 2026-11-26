package board

import (
	"context"
	"strings"
)

// CurrentTask is the task an agent is on: its number, title and whether it is in progress or only queued.
type CurrentTask struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"` // "in_progress" or "pending" (queued)
}

// CurrentTaskKey is the key CurrentTasks files an agent's task under: the board and the assignee's name, lower case (a task's assignee is matched without case, as ClaimedTaskOf does).
func CurrentTaskKey(board, assignee string) string {
	return board + "\x00" + strings.ToLower(strings.TrimSpace(assignee))
}

// CurrentTasks is, for every assignee of an open task on any board, the task that assignee is on (#21685, the sidebar's Group by task): the task in progress (the one claimed most recently), else the oldest queued
// task. An assignee with neither has no entry. Drafts, blocked, review-pending and finished tasks are not "on a task".
func (s *Store) CurrentTasks(ctx context.Context) (map[string]CurrentTask, error) {
	var rows []struct {
		ID       int64  `db:"id"`
		BoardID  string `db:"board_id"`
		Title    string `db:"title"`
		Status   string `db:"status"`
		Assignee string `db:"assigned_to"`
	}
	// In progress first (newest claim first), then queued (oldest first): the first row of an assignee is the one to show.
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, title, status, assigned_to FROM board_tasks
		WHERE assigned_to IS NOT NULL AND assigned_to <> '' AND status IN ('in_progress', 'pending')
		ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
			CASE status WHEN 'in_progress' THEN COALESCE(claimed_at, created_at) END DESC,
			CASE status WHEN 'pending' THEN created_at END ASC, id ASC`); err != nil {
		return nil, err
	}
	out := make(map[string]CurrentTask, len(rows))
	for _, r := range rows {
		k := CurrentTaskKey(r.BoardID, r.Assignee)
		if _, seen := out[k]; !seen {
			out[k] = CurrentTask{ID: r.ID, Title: r.Title, Status: r.Status}
		}
	}
	return out, nil
}
