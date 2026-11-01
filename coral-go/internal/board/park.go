package board

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Parking a task (#4175 step 3): the orchestrator or the Operator sets a task aside on purpose
// (waiting on the operator, a date, another team), with a reason and an optional end. A parked
// task raises no stale reminder, no claim or status nudge and no item in the orchestrator's
// check, until it is unparked or its end passes. It is two columns, not a status: the task keeps
// its status, owner and review state. Who may park is the route's decision (Security's #4176
// rule 19); the reason is stored cleaned by the caller (rule 2).

// parkedSQL is true for a parked task: a reason, and no end or an end still to come.
const parkedSQL = `(parked_reason IS NOT NULL AND (parked_until IS NULL OR parked_until > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

// MaxParkedPerAgent is the most parked tasks one agent may hold (#11660, the Operator's rule): parking is for work that waits on something outside the agent's hands, not a place to put work it will not do now (that is
// ReleaseTask). Parks made before the cap are left as they are and reported; only a new park is refused.
const MaxParkedPerAgent = 2

// ErrParkCap is a park that would be an agent's fourth.
type ErrParkCap struct {
	Assignee string
	Held     int
}

func (e *ErrParkCap) Error() string {
	return fmt.Sprintf("%s already holds %d parked tasks (at most %d): release one to the queue or finish one", e.Assignee, e.Held, MaxParkedPerAgent)
}

// ErrNotParkable is a task that is finished (completed or cancelled): there is nothing to park.
var ErrNotParkable = errors.New("only an open task can be parked")

// Parked reports whether the task is parked at now.
func (t *Task) Parked(now time.Time) bool {
	if t == nil || t.ParkedReason == nil {
		return false
	}
	if t.ParkedUntil == nil || *t.ParkedUntil == "" {
		return true
	}
	until, err := time.Parse(time.RFC3339, *t.ParkedUntil)
	return err != nil || until.After(now)
}

// ParkTask parks a task with a reason (already cleaned) until until (zero: until unparked). A task that is not parked yet and has an owner who already holds MaxParkedPerAgent parked tasks is refused (*ErrParkCap);
// changing the reason or the end of a task that is parked already is never refused, whatever the owner holds.
func (s *Store) ParkTask(ctx context.Context, project string, id int64, reason string, until time.Time) (*Task, error) {
	var end any
	if !until.IsZero() {
		end = until.UTC().Format(time.RFC3339)
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var cur struct {
		Status   string  `db:"status"`
		Assignee *string `db:"assigned_to"`
		Parked   bool    `db:"parked"`
	}
	if err := tx.GetContext(ctx, &cur, `SELECT status, assigned_to, `+parkedSQL+` AS parked FROM board_tasks WHERE board_id = ? AND id = ?`, project, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, sql.ErrNoRows
		}
		return nil, err
	}
	if cur.Status == "completed" || cur.Status == "cancelled" {
		return nil, fmt.Errorf("%w: #%d is %s", ErrNotParkable, id, cur.Status)
	}
	if !cur.Parked && cur.Assignee != nil && *cur.Assignee != "" {
		var held int
		if err := tx.GetContext(ctx, &held, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND id != ? AND LOWER(assigned_to) = LOWER(?) AND status NOT IN ('completed', 'cancelled') AND `+parkedSQL, project, id, *cur.Assignee); err != nil {
			return nil, err
		}
		if held >= MaxParkedPerAgent {
			return nil, &ErrParkCap{Assignee: *cur.Assignee, Held: held}
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE board_tasks SET parked_reason = ?, parked_until = ?, parked_at = CASE WHEN `+parkedSQL+` THEN COALESCE(parked_at, ?) ELSE ? END
		WHERE board_id = ? AND id = ?`, reason, end, nowUTC(), nowUTC(), project, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, project, id)
}

// ErrNotReleasable is a task that cannot go back to the queue: it is finished, awaiting review, or not there.
var ErrNotReleasable = errors.New("only an open task that is not under review can be released")

// ReleaseTask puts "not now" work back in the queue instead of parking it (#11660): the task goes to pending, its claim and any park are cleared, and it is unassigned unless keepAssigned (then its owner keeps it and
// claims it again when ready). Who may release is the route's decision.
func (s *Store) ReleaseTask(ctx context.Context, project string, id int64, keepAssigned bool) (*Task, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE board_tasks
		SET status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END, assigned_to = CASE WHEN ? THEN assigned_to ELSE NULL END, claimed_at = NULL, session_id = NULL, parked_reason = NULL, parked_until = NULL, parked_at = NULL
		WHERE id = ? AND board_id = ? AND status IN ('pending', 'in_progress', 'blocked') AND NOT EXISTS (SELECT 1 FROM task_workflows w WHERE w.task_id = board_tasks.id AND json_extract(w.data, '$.completion_review') IS NOT NULL)`,
		keepAssigned, id, project)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if t, gerr := s.GetTask(ctx, project, id); gerr != nil || t == nil {
			return nil, sql.ErrNoRows
		}
		return nil, fmt.Errorf("%w: #%d", ErrNotReleasable, id)
	}
	return s.GetTask(ctx, project, id)
}

// ParkedSince is the time each parked task of the project was parked, by task id, for the tasks given (a park made before the time was recorded is not there).
func (s *Store) ParkedSince(ctx context.Context, project string) (map[int64]time.Time, error) {
	var rows []struct {
		ID int64  `db:"id"`
		At string `db:"parked_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, parked_at FROM board_tasks WHERE board_id = ? AND parked_at IS NOT NULL AND `+parkedSQL, project); err != nil {
		return nil, err
	}
	out := make(map[int64]time.Time, len(rows))
	for _, r := range rows {
		if t, err := time.Parse(time.RFC3339, r.At); err == nil {
			out[r.ID] = t
		}
	}
	return out, nil
}

// UnparkTask clears a task's parking. A task in progress takes its owner's active-task slot back (#7819); when the owner has claimed another task meanwhile and holds the slot, the unparked task
// goes back to pending (the owner is kept) instead, so a member never has two tasks in progress: it is claimed next, after the one in hand.
func (s *Store) UnparkTask(ctx context.Context, project string, id int64) (*Task, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE board_tasks SET parked_reason = NULL, parked_until = NULL, parked_at = NULL WHERE board_id = ? AND id = ?`, project, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, sql.ErrNoRows
	}
	if _, err := tx.ExecContext(ctx, `UPDATE board_tasks SET status = 'pending' WHERE board_id = ? AND id = ? AND status = 'in_progress' AND assigned_to IS NOT NULL AND assigned_to != ''
		AND EXISTS (SELECT 1 FROM board_tasks o WHERE o.board_id = board_tasks.board_id AND o.assigned_to = board_tasks.assigned_to AND o.id != board_tasks.id AND o.`+holdsSlotSQL+`)`, project, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, project, id)
}

// lapsedParkSQL is true for a task whose parking has an end that has passed: it is parked no more (parkedSQL), so it holds its owner's slot again without anything having run.
const lapsedParkSQL = `(parked_reason IS NOT NULL AND parked_until IS NOT NULL AND parked_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`

// ReleaseLapsedParks gives a task in progress whose timed park has ended its owner's slot back, as UnparkTask does for a park lifted by hand (#11659): the parking is cleared, and when the owner holds
// another task meanwhile the task goes back to pending (the owner is kept) instead, so a member never has two tasks in progress. Several lapsed parks of one owner keep the oldest claim and requeue
// the rest. project "" releases every board. It returns how many tasks were requeued.
func (s *Store) ReleaseLapsedParks(ctx context.Context, project string) (int, error) {
	q := `SELECT id, board_id FROM board_tasks WHERE status = 'in_progress' AND assigned_to IS NOT NULL AND assigned_to != '' AND ` + lapsedParkSQL
	var args []any
	if project != "" {
		q += ` AND board_id = ?`
		args = append(args, project)
	}
	q += ` ORDER BY claimed_at, id`
	type lapsed struct {
		ID    int64  `db:"id"`
		Board string `db:"board_id"`
	}
	var rows []lapsed
	if err := s.reader().SelectContext(ctx, &rows, q, args...); err != nil || len(rows) == 0 {
		return 0, err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	requeued := 0
	for _, r := range rows {
		if _, err := tx.ExecContext(ctx, `UPDATE board_tasks SET parked_reason = NULL, parked_until = NULL WHERE board_id = ? AND id = ? AND `+lapsedParkSQL, r.Board, r.ID); err != nil {
			return 0, err
		}
		res, err := tx.ExecContext(ctx, `UPDATE board_tasks SET status = 'pending' WHERE board_id = ? AND id = ? AND status = 'in_progress'
			AND EXISTS (SELECT 1 FROM board_tasks o WHERE o.board_id = board_tasks.board_id AND o.assigned_to = board_tasks.assigned_to AND o.id != board_tasks.id AND o.`+holdsSlotSQL+`)`, r.Board, r.ID)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			requeued += int(n)
		}
	}
	return requeued, tx.Commit()
}
