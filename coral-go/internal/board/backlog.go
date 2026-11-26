package board

import (
	"context"
	"database/sql"
	"fmt"
)

// Backlog (#21701): a task given to someone (or to nobody) for later. It is a park whose reason is the one word BacklogReason and that has no end: so it is quiet the way a park is (no assignment wake, no claim or
// status nudge, no line in the check or the stale sweep, not offered to a bare claim), and it is not counted against the park limit or named by the check as an old park. Its assignee claims it by number
// (task claim N), which promotes it; the orchestrator or the Operator promotes it with unpark.
const BacklogReason = "backlog"

// InBacklog reports whether the task is parked as backlog.
func (t *Task) InBacklog() bool {
	return t != nil && t.ParkedReason != nil && *t.ParkedReason == BacklogReason && (t.ParkedUntil == nil || *t.ParkedUntil == "")
}

// SetBacklog puts an open task that is not started (pending, blocked or a draft) into the backlog.
func (s *Store) SetBacklog(ctx context.Context, project string, id int64) (*Task, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET parked_reason = ?, parked_until = NULL, parked_at = ?
		WHERE id = ? AND board_id = ? AND status IN ('pending', 'blocked', 'draft') AND NOT `+parkedSQL, BacklogReason, nowUTC(), id, project)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		t, gerr := s.GetTask(ctx, project, id)
		if gerr != nil || t == nil {
			return nil, sql.ErrNoRows
		}
		if t.InBacklog() {
			return t, nil
		}
		return nil, fmt.Errorf("task #%d is %s: only a task that is not started can go to the backlog", id, t.Status)
	}
	return s.GetTask(ctx, project, id)
}
