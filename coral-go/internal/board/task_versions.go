package board

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jmoiron/sqlx"
	"strings"
)

// TaskText is the editable task text, independent of lifecycle and patch revisions.
type TaskText struct {
	Title        string `db:"title" json:"title"`
	Body         string `db:"body" json:"body"`
	Priority     string `db:"priority" json:"priority"`
	Instructions string `db:"-" json:"instructions"`
}
type TaskTextChange struct {
	Before string `json:"before"`
	After  string `json:"after"`
}

// TaskVersion is immutable: restoring an old snapshot appends another row.
type TaskVersion struct {
	Version      int                       `db:"version" json:"version"`
	Editor       string                    `db:"editor" json:"editor"`
	CreatedAt    string                    `db:"created_at" json:"created_at"`
	Snapshot     TaskText                  `db:"-" json:"snapshot"`
	Changes      map[string]TaskTextChange `db:"-" json:"changes"`
	SnapshotJSON string                    `db:"snapshot_json" json:"-"`
	ChangesJSON  string                    `db:"changes_json" json:"-"`
}

func (s *Store) ensureTaskVersions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS task_versions (
 task_id INTEGER NOT NULL REFERENCES board_tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 editor TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, changes_json TEXT NOT NULL,
 PRIMARY KEY(task_id,version));
 CREATE TRIGGER IF NOT EXISTS task_initial_version AFTER INSERT ON board_tasks BEGIN
 INSERT INTO task_versions VALUES(NEW.id,1,NEW.created_by,NEW.created_at,json_object('title',NEW.title,'body',COALESCE(NEW.body,''),'priority',NEW.priority,'instructions',NEW.initial_instructions),'{}'); END;`)
	if err != nil {
		return err
	}
	// Older unrecorded edits cannot be recovered: capture their current effective text once.
	var ids []int64
	if err = s.db.SelectContext(ctx, &ids, "SELECT id FROM board_tasks WHERE id NOT IN (SELECT task_id FROM task_versions)"); err != nil {
		return err
	}
	for _, id := range ids {
		text, err := readTaskText(ctx, s.db, id)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(text)
		if _, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_versions VALUES(?,1,'Migration',?,?,'{}')`, id, nowUTC(), string(raw)); err != nil {
			return err
		}
	}
	return nil
}

func readTaskText(ctx context.Context, q sqlx.QueryerContext, id int64) (TaskText, error) {
	var text TaskText
	err := sqlx.GetContext(ctx, q, &text, "SELECT title,COALESCE(body,'') AS body,priority FROM board_tasks WHERE id=?", id)
	if err != nil {
		return text, err
	}
	text.Instructions, err = effectiveTaskTextInstructions(ctx, q, id)
	return text, err
}
func effectiveTaskTextInstructions(ctx context.Context, q sqlx.QueryerContext, id int64) (string, error) {
	w, err := loadWorkflow(ctx, q, id)
	if err != nil {
		return "", err
	}
	var rows []TaskAmendment
	if err = sqlx.SelectContext(ctx, q, &rows, "SELECT id,revision,actor,created_at,reason,changes_json,previous_snapshot_json,effective_snapshot_json FROM task_amendments WHERE task_id=? ORDER BY revision", id); err != nil {
		return "", err
	}
	if err = decodeAmendments(rows); err != nil {
		return "", err
	}
	w.Amendments = rows
	t := Task{}
	finishWorkflow(&t, w)
	return t.Workflow.EffectiveInstructions, nil
}
func textChanges(a, b TaskText) map[string]TaskTextChange {
	out := map[string]TaskTextChange{}
	for key, pair := range map[string][2]string{"title": {a.Title, b.Title}, "body": {a.Body, b.Body}, "priority": {a.Priority, b.Priority}, "instructions": {a.Instructions, b.Instructions}} {
		if pair[0] != pair[1] {
			out[key] = TaskTextChange{pair[0], pair[1]}
		}
	}
	return out
}
func recordTaskText(ctx context.Context, tx *sqlx.Tx, id int64, editor string, before, after TaskText) error {
	changes := textChanges(before, after)
	if len(changes) == 0 {
		return nil
	}
	// Legacy tasks get their baseline before the first edit too.
	b, _ := json.Marshal(before)
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_versions SELECT id,1,created_by,created_at,?,'{}' FROM board_tasks WHERE id=?`, string(b), id); err != nil {
		return err
	}
	a, _ := json.Marshal(after)
	c, _ := json.Marshal(changes)
	_, err := tx.ExecContext(ctx, `INSERT INTO task_versions(task_id,version,editor,created_at,snapshot_json,changes_json) SELECT ?,COALESCE(MAX(version),0)+1,?,?,?,? FROM task_versions WHERE task_id=?`, id, editor, nowUTC(), string(a), string(c), id)
	return err
}
func (s *Store) TaskHistory(ctx context.Context, project string, id int64) ([]TaskVersion, error) {
	var rows []TaskVersion
	err := s.reader().SelectContext(ctx, &rows, `SELECT version,editor,created_at,snapshot_json,changes_json FROM task_versions WHERE task_id IN (SELECT id FROM board_tasks WHERE board_id=? AND id=?) ORDER BY version`, project, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("task #%d not found", id)
	}
	for i := range rows {
		if err = json.Unmarshal([]byte(rows[i].SnapshotJSON), &rows[i].Snapshot); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(rows[i].ChangesJSON), &rows[i].Changes); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// EditTaskText serializes the text update and its history in the same transaction.
// The HTTP layer authenticates the editor and checks creator/planner authority.
func (s *Store) EditTaskText(ctx context.Context, project string, id int64, editor string, title, priority *string, restore, baseVersion int) (*Task, error) {
	if restore < 0 || baseVersion < 0 {
		return nil, fmt.Errorf("versions must be positive")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	if err = tx.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil {
		return nil, err
	}
	if status == "completed" || status == "skipped" {
		return nil, fmt.Errorf("task #%d cannot be edited (status: %s)", id, status)
	}
	before, err := readTaskText(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	after := before
	var version int
	if err = tx.GetContext(ctx, &version, "SELECT COALESCE(MAX(version),1) FROM task_versions WHERE task_id=?", id); err != nil {
		return nil, err
	}
	if baseVersion > 0 && version != baseVersion {
		return nil, fmt.Errorf("task changed to v%d; reread before editing", version)
	}
	if restore > 0 {
		if title != nil || priority != nil {
			return nil, fmt.Errorf("restore_version cannot be mixed with fields")
		}
		var snapshot string
		if err = tx.GetContext(ctx, &snapshot, "SELECT snapshot_json FROM task_versions WHERE task_id=? AND version=?", id, restore); err != nil {
			return nil, fmt.Errorf("task version not found")
		}
		if err = json.Unmarshal([]byte(snapshot), &after); err != nil {
			return nil, err
		}
	} else {
		if title == nil && priority == nil {
			return nil, fmt.Errorf("title or priority is required")
		}
		if title != nil {
			after.Title = strings.TrimSpace(*title)
		}
		if priority != nil {
			after.Priority = *priority
		}
	}
	if after.Title == "" || len(after.Title) > 512 {
		return nil, fmt.Errorf("title must be 1–512 bytes")
	}
	if err = checkPriority(after.Priority); err != nil {
		return nil, err
	}
	if len(textChanges(before, after)) == 0 {
		return nil, fmt.Errorf("no text changed")
	}
	bumpRevision := 0
	if restore > 0 && (before.Body != after.Body || before.Instructions != after.Instructions) {
		bumpRevision = 1
	}
	if restore > 0 && before.Instructions != after.Instructions {
		var revision int
		if err = tx.GetContext(ctx, &revision, "SELECT revision FROM board_tasks WHERE id=?", id); err != nil {
			return nil, err
		}
		workflow, err := loadWorkflow(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		workflow.RestoredInstructions = &after.Instructions
		workflow.RestoredInstructionsRevision = revision + bumpRevision
		if err = saveWorkflow(ctx, tx, id, workflow); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE board_tasks SET title=?,body=NULLIF(?,''),priority=?,revision=revision+?,edited_at=? WHERE id=? AND board_id=?", after.Title, after.Body, after.Priority, bumpRevision, nowUTC(), id, project); err != nil {
		return nil, err
	}
	if err = recordTaskText(ctx, tx, id, editor, before, after); err != nil {
		return nil, err
	}
	if status == "review_pending" {
		if err = staleTaskTextReviews(ctx, tx, id); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, project, id)
}

// Keep an older approval visible, but reopen its reviewer task and prevent completion.
func staleTaskTextReviews(ctx context.Context, tx *sqlx.Tx, id int64) error {
	w, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return err
	}
	if len(w.ReviewRounds) == 0 {
		return nil
	}
	round := &w.ReviewRounds[len(w.ReviewRounds)-1]
	for i := range round.Reviewers {
		me := &round.Reviewers[i]
		if me.State != "approved" {
			continue
		}
		if me.TaskVersion == 0 {
			me.TaskVersion = 1
		}
		me.PreviousTextApprovals = append(me.PreviousTextApprovals, TaskTextApproval{Version: me.TaskVersion, Note: me.Note, At: me.At})
		me.State = "stale"
		if _, err = tx.ExecContext(ctx, `UPDATE board_tasks SET status='pending',assigned_to=?,completed_by=NULL,completed_at=NULL,completion_message=NULL,claimed_at=NULL,session_id=NULL WHERE id=? AND status='completed'`, me.Reviewer, me.ReviewTaskID); err != nil {
			return err
		}
		rw, err := loadWorkflow(ctx, tx, me.ReviewTaskID)
		if err != nil {
			return err
		}
		rw.Outcome = ""
		rw.CompletionReview = nil
		if err = saveWorkflow(ctx, tx, me.ReviewTaskID, rw); err != nil {
			return err
		}
	}
	round.Result = ""
	round.ConcludedAt = ""
	return saveWorkflow(ctx, tx, id, w)
}
