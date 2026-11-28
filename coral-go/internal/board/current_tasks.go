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
	// GoalID and GoalTitle: the goal the task belongs to (#22093), absent for none.
	GoalID    int64  `json:"goal_id,omitempty"`
	GoalTitle string `json:"goal_title,omitempty"`
}

// CurrentTaskKey is the key CurrentTasks files an agent's task under: the board and the assignee's name, lower case (a task's assignee is matched without case, as ClaimedTaskOf does).
func CurrentTaskKey(board, assignee string) string {
	return board + "\x00" + strings.ToLower(strings.TrimSpace(assignee))
}

// CurrentTasks is, for every assignee of an open task on any board, the task that assignee is on (#21685, the sidebar's Group by task): the task in progress (the one claimed most recently), else the oldest queued
// task. An assignee with neither has no entry. Drafts, blocked, review-pending and finished tasks are not "on a task".
func (s *Store) CurrentTasks(ctx context.Context) (map[string]CurrentTask, error) {
	var rows []struct {
		ID        int64   `db:"id"`
		BoardID   string  `db:"board_id"`
		Title     string  `db:"title"`
		Status    string  `db:"status"`
		Assignee  string  `db:"assigned_to"`
		GoalID    *int64  `db:"goal_id"`
		GoalTitle *string `db:"goal_title"`
	}
	// In progress first (newest claim first), then queued (oldest first): the first row of an assignee is the one to show.
	if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id, t.board_id, t.title, t.status, t.assigned_to, t.goal_id, g.title AS goal_title FROM board_tasks t
		LEFT JOIN board_goals g ON g.id = t.goal_id AND g.board_id = t.board_id
		WHERE t.assigned_to IS NOT NULL AND t.assigned_to <> '' AND t.status IN ('in_progress', 'pending')
		ORDER BY CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
			CASE t.status WHEN 'in_progress' THEN COALESCE(t.claimed_at, t.created_at) END DESC,
			CASE t.status WHEN 'pending' THEN t.created_at END ASC, t.id ASC`); err != nil {
		return nil, err
	}
	out := make(map[string]CurrentTask, len(rows))
	for _, r := range rows {
		k := CurrentTaskKey(r.BoardID, r.Assignee)
		if _, seen := out[k]; !seen {
			ct := CurrentTask{ID: r.ID, Title: r.Title, Status: r.Status}
			if r.GoalID != nil && r.GoalTitle != nil {
				ct.GoalID, ct.GoalTitle = *r.GoalID, *r.GoalTitle
			}
			out[k] = ct
		}
	}
	return out, nil
}
