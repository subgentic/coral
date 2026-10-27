package board

import (
	"context"
	"time"
)

// OffBooksGoalReady and OffBooksUnowned are the kinds of two lines of the orchestrator's check (#8975, goal #80): a goal whose every task has been done for the team's wait (it is ready to close),
// and open tasks that have no goal or no assignee after the team's wait. Both are the board's own lines, shown once like a goal's size: numbers only, never a goal's or a task's title.
const (
	OffBooksGoalReady = "goalready"
	OffBooksUnowned   = "unowned"
)

// GoalReady is a goal that is not closed and whose every task is done: how many tasks it has (review tasks are not work) and when the last was done.
type GoalReady struct {
	ID    int64
	Tasks int
	Done  time.Time
}

// GoalsReadyToClose lists the board's goals, not done or dropped, that have at least one completed task and no task that is still open or a draft, whose last task was done at or before
// doneBefore. A cancelled (skipped) task is not open, but a goal with only cancelled tasks is not ready: something has to have been completed. Review tasks are not counted.
func (s *Store) GoalsReadyToClose(ctx context.Context, project string, doneBefore time.Time) ([]GoalReady, error) {
	var rows []struct {
		ID    int64  `db:"id"`
		Tasks int    `db:"tasks"`
		Done  string `db:"done"`
	}
	err := s.reader().SelectContext(ctx, &rows, `SELECT g.id AS id, COUNT(t.id) AS tasks, MAX(t.completed_at) AS done
		FROM board_goals g
		JOIN board_tasks t ON t.board_id = g.board_id AND t.goal_id = g.id
		LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE g.board_id = ? AND g.state NOT IN ('done', 'dropped') AND COALESCE(json_extract(w.data, '$.review_of'), 0) = 0
		GROUP BY g.id
		HAVING SUM(CASE WHEN t.status IN ('completed', 'skipped') THEN 0 ELSE 1 END) = 0
		   AND SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) > 0
		   AND MAX(t.completed_at) <= ?
		ORDER BY g.id`, project, doneBefore.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	out := make([]GoalReady, 0, len(rows))
	for _, r := range rows {
		done, err := time.Parse(time.RFC3339, r.Done)
		if err != nil {
			continue
		}
		out = append(out, GoalReady{ID: r.ID, Tasks: r.Tasks, Done: done})
	}
	return out, nil
}

// UnownedTask is an open task that has no goal, no assignee, or neither.
type UnownedTask struct {
	ID         int64
	NoGoal     bool
	NoAssignee bool
}

// UnownedOpenTasks lists the board's open tasks (pending, in progress or blocked; not drafts, not reviews) created at or before createdBefore that have no goal or no assignee, by number.
func (s *Store) UnownedOpenTasks(ctx context.Context, project string, createdBefore time.Time) ([]UnownedTask, error) {
	var rows []struct {
		ID         int64 `db:"id"`
		NoGoal     bool  `db:"no_goal"`
		NoAssignee bool  `db:"no_assignee"`
	}
	err := s.reader().SelectContext(ctx, &rows, `SELECT t.id AS id,
			(t.goal_id IS NULL OR t.goal_id = 0) AS no_goal,
			(t.assigned_to IS NULL OR t.assigned_to = '') AS no_assignee
		FROM board_tasks t
		LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status IN ('pending', 'in_progress', 'blocked') AND t.created_at <= ?
		  AND (t.goal_id IS NULL OR t.goal_id = 0 OR t.assigned_to IS NULL OR t.assigned_to = '')
		  AND COALESCE(json_extract(w.data, '$.review_of'), 0) = 0
		ORDER BY t.id`, project, createdBefore.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	out := make([]UnownedTask, 0, len(rows))
	for _, r := range rows {
		out = append(out, UnownedTask{ID: r.ID, NoGoal: r.NoGoal, NoAssignee: r.NoAssignee})
	}
	return out, nil
}
