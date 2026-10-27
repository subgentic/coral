package board

import (
	"context"
	"fmt"
	"strings"
)

func (s *Store) ensureGoalsSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_goals (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			goal_uid      TEXT NOT NULL,
			board_id      TEXT NOT NULL,
			title         TEXT NOT NULL,
			outcome       TEXT NOT NULL DEFAULT '',
			done_when     TEXT NOT NULL DEFAULT '',
			state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('proposed', 'active', 'blocked', 'done', 'dropped')),
			blocked_on    TEXT NOT NULL DEFAULT '',
			driver        TEXT NOT NULL DEFAULT '',
			created_by    TEXT NOT NULL DEFAULT '',
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			closed_at     TEXT,
			closed_reason TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_board_goals_uid ON board_goals(goal_uid)`,
		`CREATE INDEX IF NOT EXISTS idx_board_goals_board ON board_goals(board_id, state, id)`,
		// A goal's uid is set at creation and never changes: a reference that outlives re-enrolling and board re-keys is made of it.
		`CREATE TRIGGER IF NOT EXISTS board_goals_uid_immutable BEFORE UPDATE OF goal_uid ON board_goals WHEN OLD.goal_uid IS NOT NEW.goal_uid
			BEGIN SELECT RAISE(ABORT, 'a goal uid is never changed'); END`,
		// The per-board change counter the feed's goals summary carries: one row per board, moved by the database itself on every goal write and every task change that touches a goal, so no
		// writer of board_tasks can forget it (the triggers are the census).
		// The goal events the feed can name (#7355): one row for what a counter move was (ids, a kind and the counter value it gave, never text), written by the same triggers as the move, in the same
		// transaction. Pruned by a periodic job (PruneGoalEvents): the feed's window is the newest few, and a connection that fell behind the window refetches.
		`CREATE TABLE IF NOT EXISTS board_goal_events (
			id       INTEGER PRIMARY KEY AUTOINCREMENT,
			board_id TEXT NOT NULL,
			goal_id  INTEGER NOT NULL,
			kind     TEXT NOT NULL,
			seq      INTEGER NOT NULL,
			at       TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_board_goal_events_board ON board_goal_events(board_id, id)`,
		`CREATE TABLE IF NOT EXISTS board_goal_meta (
			board_id   TEXT PRIMARY KEY,
			seq        INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	for _, ddl := range []string{"ALTER TABLE board_tasks ADD COLUMN goal_id INTEGER", "ALTER TABLE boards ADD COLUMN board_uid TEXT"} {
		if _, err := s.db.ExecContext(ctx, ddl); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// The goal decision fields (decision, recommendation, if_silent) and the answer are gone (#7300, the Operator's decision: a goal does not wait on a person): a database that has the columns drops them, after the
	// trigger that watches them, which is made again below without them.
	if _, err := s.db.ExecContext(ctx, `DROP TRIGGER IF EXISTS board_goals_seq_update`); err != nil {
		return err
	}
	for _, col := range []string{"decision", "recommendation", "if_silent", "answer"} {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE board_goals DROP COLUMN "+col); err != nil && !strings.Contains(err.Error(), "no such column") {
			return err
		}
	}
	const bump = `INSERT INTO board_goal_meta (board_id, seq, updated_at) VALUES (%s, 1, strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ', 'now'))
		ON CONFLICT(board_id) DO UPDATE SET seq = seq + 1, updated_at = excluded.updated_at;`
	// event is the row for what the counter move above was (board, goal, kind), with the counter value it gave; cond (a SQL condition, "1" for always) lets one trigger write more than one.
	event := func(board, goal, kind, cond string) string {
		return fmt.Sprintf(` INSERT INTO board_goal_events (board_id, goal_id, kind, seq, at) SELECT %[1]s, %[2]s, '%[3]s', seq, strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ', 'now') FROM board_goal_meta WHERE board_id = %[1]s AND (%[4]s);`, board, goal, kind, cond)
	}
	moved := func(board string) string { return fmt.Sprintf(bump, board) }
	const goalChanged = `OLD.title IS NOT NEW.title OR OLD.outcome IS NOT NEW.outcome OR OLD.done_when IS NOT NEW.done_when OR OLD.state IS NOT NEW.state OR OLD.blocked_on IS NOT NEW.blocked_on OR OLD.driver IS NOT NEW.driver
			OR OLD.closed_at IS NOT NEW.closed_at OR OLD.closed_reason IS NOT NEW.closed_reason`
	const wasClosed, nowClosed = `OLD.state IN ('done', 'dropped')`, `NEW.state IN ('done', 'dropped')`
	for _, stmt := range []string{
		// The rollup's grouped count reads (board_id, goal_id, status) and nothing else of the task, so the index holds status and the count is index-only (#9584: 1.6 to 0.36 ms for a page of 40 goals). It is the older
		// (board_id, goal_id) index with a column more, so that one is dropped: the same write cost, the same lookups.
		`CREATE INDEX IF NOT EXISTS idx_board_tasks_goal_status ON board_tasks(board_id, goal_id, status) WHERE goal_id IS NOT NULL`,
		`DROP INDEX IF EXISTS idx_board_tasks_goal`,
		// A board's own uid (boards.board_uid) is set by CreateBoard only, is unique where there is one, and is never changed once set: no backfill (a board made before it has none).
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_board_uid ON boards(board_uid) WHERE board_uid IS NOT NULL`,
		`CREATE TRIGGER IF NOT EXISTS boards_board_uid_immutable BEFORE UPDATE OF board_uid ON boards WHEN OLD.board_uid IS NOT NULL AND NEW.board_uid IS NOT OLD.board_uid
			BEGIN SELECT RAISE(ABORT, 'a board uid is never changed'); END`,
		// Each trigger moves the counter and writes the event of that move in one body (#7355), so a counter move and its event cannot part. They are dropped and made again so a database that has the older ones
		// (without the event) gets these. The update triggers fire only when a column they watch really changes (#7239): an UPDATE that writes the same values is not a change, and an open Goals view refreshes on this counter.
		`DROP TRIGGER IF EXISTS board_goals_seq_insert`,
		`CREATE TRIGGER board_goals_seq_insert AFTER INSERT ON board_goals BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.id", "goal_created", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_goals_seq_update`,
		`CREATE TRIGGER board_goals_seq_update AFTER UPDATE OF title, outcome, done_when, state, blocked_on, driver, closed_at, closed_reason ON board_goals
			WHEN (` + goalChanged + `) AND ((` + wasClosed + `) = (` + nowClosed + `))
			BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.id", "goal_updated", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_goals_seq_closed`,
		`CREATE TRIGGER board_goals_seq_closed AFTER UPDATE OF state ON board_goals WHEN NOT (` + wasClosed + `) AND (` + nowClosed + `)
			BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.id", "goal_closed", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_goals_seq_reopened`,
		`CREATE TRIGGER board_goals_seq_reopened AFTER UPDATE OF state ON board_goals WHEN (` + wasClosed + `) AND NOT (` + nowClosed + `)
			BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.id", "goal_reopened", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_goals_seq_delete`,
		`CREATE TRIGGER board_goals_seq_delete AFTER DELETE ON board_goals BEGIN ` + moved("OLD.board_id") + event("OLD.board_id", "OLD.id", "goal_deleted", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_insert`,
		`CREATE TRIGGER board_tasks_goal_seq_insert AFTER INSERT ON board_tasks WHEN NEW.goal_id IS NOT NULL BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.goal_id", "task_linked", "1") + ` END`,
		// a task's status changed, in the same goal: task_state; the goal changed (linked, unlinked or moved): one counter move, an event for the goal it left and one for the goal it joined
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_update`,
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_state`,
		`CREATE TRIGGER board_tasks_goal_seq_state AFTER UPDATE OF status ON board_tasks WHEN OLD.goal_id IS NEW.goal_id AND NEW.goal_id IS NOT NULL AND OLD.status IS NOT NEW.status
			BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "NEW.goal_id", "task_state", "1") + ` END`,
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_move`,
		`CREATE TRIGGER board_tasks_goal_seq_move AFTER UPDATE OF goal_id ON board_tasks WHEN OLD.goal_id IS NOT NEW.goal_id
			BEGIN ` + moved("NEW.board_id") + event("NEW.board_id", "OLD.goal_id", "task_unlinked", "OLD.goal_id IS NOT NULL") + event("NEW.board_id", "NEW.goal_id", "task_linked", "NEW.goal_id IS NOT NULL") + ` END`,
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_delete`,
		`CREATE TRIGGER board_tasks_goal_seq_delete AFTER DELETE ON board_tasks WHEN OLD.goal_id IS NOT NULL BEGIN ` + moved("OLD.board_id") + event("OLD.board_id", "OLD.goal_id", "task_unlinked", "1") + ` END`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}
