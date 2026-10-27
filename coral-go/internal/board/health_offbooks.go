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

// OffBooksLanding is the kind of a line about the branch work lands on standing still while tasks finish (#8942): the board's own, shown once like a goal's size, a line of the check and nothing else. The ref is the repository, branch, tip and
// which wait it is (each further wait is a new occurrence).
const OffBooksLanding = "landing"

// AddOffBooksOnce is AddOffBooks that says whether the occurrence was new: one recorded before, shown or not, is not.
func (s *Store) AddOffBooksOnce(ctx context.Context, project, kind, agent, ref, detail string, at time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO health_offbooks (project, kind, agent, ref, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
		project, kind, agent, ref, detail, at.UTC().Format(healthTimeFormat))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// OffBooksGoalSize is the kind of a line the orchestrator's check says about a goal that has grown past the team's limit (#7808): it shares this queue (shown once, a few lines a check,
// again if the check did not go out); its ref is the goal, the level and the moment of the crossing, so a goal that crossed, fell back and crossed again is a new line.
const OffBooksGoalSize = "goalsize"

// GoalSize is how many tasks one open goal has, its open and its done ones together.
type GoalSize struct {
	ID    int64 `db:"id"`
	Total int   `db:"total"`
}

// OpenGoalSizes is the task count of each of the board's goals that are not closed (done or dropped: a goal whose done-when is met is not counted). A goal with no task is not listed.
func (s *Store) OpenGoalSizes(ctx context.Context, project string) ([]GoalSize, error) {
	var out []GoalSize
	err := s.reader().SelectContext(ctx, &out, `SELECT g.id AS id, COUNT(t.id) AS total FROM board_goals g
		JOIN board_tasks t ON t.board_id = g.board_id AND t.goal_id = g.id
		WHERE g.board_id = ? AND g.state NOT IN ('done', 'dropped') GROUP BY g.id ORDER BY g.id`, project)
	return out, err
}

// goalLevel is how many whole limits a goal's tasks have passed: 0 until it has more than limit tasks, then total/limit (the limit's multiples are the steps: 15, 30, 45).
func goalLevel(total, limit int) int {
	if limit <= 0 || total <= limit {
		return 0
	}
	return total / limit
}

// NoteGoalSizes works out which goals have crossed a level since the last time: the ones whose level is above the one said (they are returned, and the level is kept), and keeps the level
// down when a goal shrinks (so it is said again when it grows back) and forgets the goals that are closed, or gone, or small again (a goal that is reopened counts afresh).
func (s *Store) NoteGoalSizes(ctx context.Context, project string, sizes []GoalSize, limit int) ([]GoalSize, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var rows []struct {
		GoalID int64 `db:"goal_id"`
		Level  int   `db:"said_level"`
	}
	if err := tx.SelectContext(ctx, &rows, `SELECT goal_id, said_level FROM health_goal_size WHERE project = ?`, project); err != nil {
		return nil, err
	}
	said := make(map[int64]int, len(rows))
	for _, r := range rows {
		said[r.GoalID] = r.Level
	}
	var crossed []GoalSize
	open := make(map[int64]bool, len(sizes))
	for _, g := range sizes {
		open[g.ID] = true
		level := goalLevel(g.Total, limit)
		prev, had := said[g.ID]
		switch {
		case level == 0:
			if had {
				if _, err := tx.ExecContext(ctx, `DELETE FROM health_goal_size WHERE project = ? AND goal_id = ?`, project, g.ID); err != nil {
					return nil, err
				}
			}
		case level > prev:
			crossed = append(crossed, g)
			fallthrough
		case level < prev:
			if _, err := tx.ExecContext(ctx, `INSERT INTO health_goal_size (project, goal_id, said_level) VALUES (?, ?, ?)
				ON CONFLICT(project, goal_id) DO UPDATE SET said_level = excluded.said_level`, project, g.ID, level); err != nil {
				return nil, err
			}
		}
	}
	for id := range said {
		if !open[id] {
			if _, err := tx.ExecContext(ctx, `DELETE FROM health_goal_size WHERE project = ? AND goal_id = ?`, project, id); err != nil {
				return nil, err
			}
		}
	}
	return crossed, tx.Commit()
}
