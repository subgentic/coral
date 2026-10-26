package board

import (
	"context"
	"strconv"
	"time"
)

// Work done off the books (#7793, goal #21 part 3): what an agent did with no task in progress, kept until the orchestrator's check has said it once. An occurrence is
// (board, kind, ref): the same one added twice is one (INSERT OR IGNORE), which is what makes each a single line however many scans or uploads see it; a shown one is
// never shown again. The kinds are Coral's own words, the agent's name is the member's, and detail is a fixed phrase with a number or a short SHA, never an agent's text.

// The kinds of an off-the-books occurrence (health_offbooks.kind).
const (
	OffBooksBusy   = "busy"   // in a turn with no task in progress: ref is the agent and when its turn began
	OffBooksPost   = "post"   // a commit, SHA or patch posted with no task: ref is the message id
	OffBooksUpload = "upload" // an artifact uploaded with no task: ref is its digest
)

// OffBooksKeep is how long an occurrence that was never shown (no live recipient) is kept.
const OffBooksKeep = 7 * 24 * time.Hour

// OffBooks is one occurrence waiting for the orchestrator's check.
type OffBooks struct {
	ID     int64  `db:"id"`
	Kind   string `db:"kind"`
	Agent  string `db:"agent"`
	Ref    string `db:"ref"`
	Detail string `db:"detail"`
	At     string `db:"at"`
}

// AddOffBooks records an occurrence; one already recorded (shown or not) is left as it is.
func (s *Store) AddOffBooks(ctx context.Context, project, kind, agent, ref, detail string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO health_offbooks (project, kind, agent, ref, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
		project, kind, agent, ref, detail, at.UTC().Format(healthTimeFormat))
	return err
}

// PendingOffBooks is the board's occurrences not shown yet, oldest first, of the kinds in want (a switch that is off leaves its kind out). Older than OffBooksKeep are dropped.
func (s *Store) PendingOffBooks(ctx context.Context, project string, now time.Time, want map[string]bool) ([]OffBooks, error) {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM health_offbooks WHERE project = ? AND at < ?`, project, now.Add(-OffBooksKeep).UTC().Format(healthTimeFormat)); err != nil {
		return nil, err
	}
	var rows []OffBooks
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, kind, agent, ref, detail, at FROM health_offbooks WHERE project = ? AND shown_at IS NULL ORDER BY id`, project); err != nil {
		return nil, err
	}
	out := rows[:0]
	for _, r := range rows {
		if want[r.Kind] {
			out = append(out, r)
		}
	}
	return out, nil
}

// MarkOffBooksShown records that the check said these occurrences: they are not said again.
func (s *Store) MarkOffBooksShown(ctx context.Context, project string, ids []int64, now time.Time) error {
	at := now.UTC().Format(healthTimeFormat)
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `UPDATE health_offbooks SET shown_at = ? WHERE project = ? AND id = ? AND shown_at IS NULL`, at, project, id); err != nil {
			return err
		}
	}
	return nil
}

const settingOffBooksPosts = "health_offbooks_post_cursor"

// OffBooksPostCursor is the id of the last board message the off-the-books scan has read; known is false before its first scan (which only marks where the board is).
func (s *Store) OffBooksPostCursor(ctx context.Context, project string) (id int64, known bool) {
	v, err := s.boardSettingValue(ctx, project, settingOffBooksPosts)
	if err != nil || v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return n, err == nil
}

// SetOffBooksPostCursor keeps it.
func (s *Store) SetOffBooksPostCursor(ctx context.Context, project string, id int64) error {
	return s.SetBoardSetting(ctx, project, settingOffBooksPosts, strconv.FormatInt(id, 10))
}

// LatestMessageID is the id of the board's newest message, 0 when it has none.
func (s *Store) LatestMessageID(ctx context.Context, project string) (int64, error) {
	var id int64
	err := s.reader().GetContext(ctx, &id, `SELECT COALESCE(MAX(id), 0) FROM board_messages WHERE project = ?`, project)
	return id, err
}

// HadTaskInProgress says whether the member had a task of the board in progress at a moment: one it claimed by then and had not completed, or completed within the grace before
// (a post "landed abc1234" is usually sent just before or just after the task is completed). The task's own timestamps decide, not what the member has now.
func (s *Store) HadTaskInProgress(ctx context.Context, project, member string, at time.Time, grace time.Duration) (bool, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND assigned_to = ? AND claimed_at IS NOT NULL AND claimed_at <= ?
		AND (completed_at IS NULL OR completed_at >= ?)`, project, member, at.UTC().Format(time.RFC3339), at.Add(-grace).UTC().Format(time.RFC3339))
	return n > 0, err
}
