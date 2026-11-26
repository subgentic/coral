package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// A task that waits on a person (#21697). Tasks stalled silently when the owner waited on someone: the owner's no-activity nudges kept coming, and the one waited on was never told. The owner marks the task
// waiting on a member or on a condition, with a reason. While it is set the owner gets no no-activity nudge for the task; the member waited on gets one health line; it clears when that member posts on the task
// or the owner clears it. It lives in the task's workflow data (a task is read with it everywhere: detail, show, list, the API). --blocked-by stays for waits on other tasks.

// TaskWaitOn is what a task waits on. Exactly one of Member and Condition is set.
type TaskWaitOn struct {
	Member    string `json:"member,omitempty"`    // a team member the owner waits on
	Condition string `json:"condition,omitempty"` // or something that is not a member ("the Operator's logo choice", "CI on main"), shown as given
	Reason    string `json:"reason"`              // why, in the owner's words (already cleaned by the caller)
	Owner     string `json:"owner"`               // the task's owner when it was set: a wait does not outlive a reassignment
	SetBy     string `json:"set_by"`
	SetAt     string `json:"set_at"`
}

// Target is who or what the task waits on, as a phrase.
func (w *TaskWaitOn) Target() string {
	if w == nil {
		return ""
	}
	if w.Member != "" {
		return w.Member
	}
	return w.Condition
}

// ErrNotWaitable is a task that cannot wait on anyone: it is finished, or not the owner's open work.
var ErrNotWaitable = errors.New("only an open, assigned task can be marked waiting")

// SetTaskWaitOn marks an open, assigned task as waiting on a member or a condition. Setting it again replaces it (and starts the wait again when the target changed).
func (s *Store) SetTaskWaitOn(ctx context.Context, project string, id int64, w TaskWaitOn) (*Task, error) {
	if (w.Member == "") == (w.Condition == "") {
		return nil, errors.New("name exactly one of a member and a condition to wait on")
	}
	if strings.TrimSpace(w.Reason) == "" {
		return nil, errors.New("a reason is required")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var cur struct {
		Status string  `db:"status"`
		Owner  *string `db:"assigned_to"`
	}
	if err := tx.GetContext(ctx, &cur, `SELECT status, assigned_to FROM board_tasks WHERE board_id = ? AND id = ?`, project, id); err != nil {
		return nil, err // sql.ErrNoRows: no such task
	}
	if cur.Owner == nil || *cur.Owner == "" || (cur.Status != "in_progress" && cur.Status != "pending") {
		return nil, fmt.Errorf("%w: #%d is %s", ErrNotWaitable, id, cur.Status)
	}
	wf, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	w.Owner = *cur.Owner
	if wf.WaitingOn != nil && wf.WaitingOn.Member == w.Member && wf.WaitingOn.Condition == w.Condition && wf.WaitingOn.Owner == w.Owner {
		w.SetAt = wf.WaitingOn.SetAt // the same wait with a new reason keeps its age
	} else {
		w.SetAt = nowUTC()
	}
	wf.WaitingOn = &w
	if err := saveWorkflow(ctx, tx, id, wf); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, project, id)
}

// ClearTaskWaitOn ends a task's wait. cleared is false when it had none.
func (s *Store) ClearTaskWaitOn(ctx context.Context, project string, id int64) (task *Task, cleared bool, err error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	var n int
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND id = ?`, project, id); err != nil {
		return nil, false, err
	}
	if n == 0 {
		return nil, false, sql.ErrNoRows
	}
	wf, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return nil, false, err
	}
	if wf.WaitingOn != nil {
		wf.WaitingOn, cleared = nil, true
		if err := saveWorkflow(ctx, tx, id, wf); err != nil {
			return nil, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	task, err = s.GetTask(ctx, project, id)
	return task, cleared, err
}

// ClearWaitOnForPost ends a task's wait when the member it waits on posts on the task (post --task N). False when the task waits on no one, or on someone else.
func (s *Store) ClearWaitOnForPost(ctx context.Context, project string, id int64, poster string) (bool, error) {
	var data string
	if err := s.reader().GetContext(ctx, &data, `SELECT w.data FROM task_workflows w JOIN board_tasks t ON t.id = w.task_id WHERE t.board_id = ? AND t.id = ?`, project, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	wf, err := decodeWorkflow(data, true)
	if err != nil || wf.WaitingOn == nil || wf.WaitingOn.Member == "" || !SameIdentity(wf.WaitingOn.Member, poster) {
		return false, err
	}
	_, cleared, err := s.ClearTaskWaitOn(ctx, project, id)
	return cleared, err
}

// TaskWait is one open task's wait, for the health check.
type TaskWait struct {
	TaskID int64
	Title  string
	Status string
	Owner  string // who holds the task now
	WaitOn TaskWaitOn
}

// Since is when the wait began.
func (w TaskWait) Since() time.Time {
	t, _ := time.Parse(time.RFC3339, w.WaitOn.SetAt)
	return t
}

// ListTaskWaits is every open task of the project that waits on someone, in task order. A wait set for an earlier owner is not listed: it does not outlive a reassignment.
func (s *Store) ListTaskWaits(ctx context.Context, project string) ([]TaskWait, error) {
	var rows []struct {
		ID     int64   `db:"id"`
		Title  string  `db:"title"`
		Status string  `db:"status"`
		Owner  *string `db:"assigned_to"`
		Data   string  `db:"data"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id, t.title, t.status, t.assigned_to, w.data FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL AND json_extract(w.data, '$.waiting_on') IS NOT NULL ORDER BY t.id`, project); err != nil {
		return nil, err
	}
	var out []TaskWait
	for _, r := range rows {
		wf, err := decodeWorkflow(r.Data, true)
		if err != nil || wf.WaitingOn == nil || r.Owner == nil || !SameIdentity(wf.WaitingOn.Owner, *r.Owner) {
			continue
		}
		out = append(out, TaskWait{TaskID: r.ID, Title: r.Title, Status: r.Status, Owner: *r.Owner, WaitOn: *wf.WaitingOn})
	}
	return out, nil
}

// fillListWaitingOn sets WaitingOn on the open items of a list page whose owner waits on someone: one batched read of the page's own ids.
func (s *Store) fillListWaitingOn(ctx context.Context, items []TaskListItem) {
	var ids []int64
	for i := range items {
		if items[i].Status == "in_progress" || items[i].Status == "pending" {
			ids = append(ids, items[i].ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	waits := map[int64]string{}
	err := forEachIDChunk(ids, func(ph string, args []any) error {
		var rows []struct {
			TaskID int64  `db:"task_id"`
			Wait   string `db:"wait"`
		}
		if err := s.reader().SelectContext(ctx, &rows, "SELECT task_id, json_extract(data, '$.waiting_on') AS wait FROM task_workflows WHERE task_id IN ("+ph+") AND json_extract(data, '$.waiting_on') IS NOT NULL", args...); err != nil {
			return err
		}
		for _, r := range rows {
			waits[r.TaskID] = r.Wait
		}
		return nil
	})
	if err != nil {
		return
	}
	for i := range items {
		raw, ok := waits[items[i].ID]
		if !ok {
			continue
		}
		var w TaskWaitOn
		if json.Unmarshal([]byte(raw), &w) == nil && items[i].AssignedTo != nil && SameIdentity(w.Owner, *items[i].AssignedTo) {
			items[i].WaitingOn = &w
		}
	}
}
