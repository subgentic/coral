package board

import (
	"context"
)

func (s *Store) createBoardCoreTables(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS board_subscribers (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			project       TEXT NOT NULL,
			session_id    TEXT NOT NULL,
			job_title     TEXT NOT NULL,
			webhook_url   TEXT,
			origin_server TEXT,
			receive_mode  TEXT NOT NULL DEFAULT 'mentions',
			last_read_id  INTEGER NOT NULL DEFAULT 0,
			subscribed_at TEXT NOT NULL,
			UNIQUE(project, session_id)
		);
		CREATE TABLE IF NOT EXISTS board_messages (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			project     TEXT NOT NULL,
			session_id  TEXT NOT NULL,
			content     TEXT NOT NULL,
			created_at  TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_board_messages_project ON board_messages(project, id);
		CREATE TABLE IF NOT EXISTS board_reminders (
			project TEXT NOT NULL,
			subscriber_id TEXT NOT NULL,
			message TEXT NOT NULL,
			interval_seconds INTEGER NOT NULL,
			PRIMARY KEY(project, subscriber_id)
		);
		CREATE TABLE IF NOT EXISTS board_groups (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			project    TEXT NOT NULL,
			group_id   TEXT NOT NULL,
			session_id TEXT NOT NULL,
			UNIQUE(project, group_id, session_id)
		);
		CREATE INDEX IF NOT EXISTS idx_board_groups_project_group ON board_groups(project, group_id);
	`)
	if err != nil {
		return err
	}
	return nil
}

func (s *Store) createBoardTaskTables(ctx context.Context) error {
	// Task tables
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS board_tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			revision INTEGER NOT NULL DEFAULT 1,
			board_id TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'blocked', 'draft', 'review_pending')),
			priority TEXT NOT NULL DEFAULT 'medium'
				CHECK (priority IN ('critical', 'high', 'medium', 'low')),
			created_by TEXT NOT NULL,
			assigned_to TEXT,
			completed_by TEXT,
			completion_message TEXT,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			completed_at TEXT,
			last_activity_at TEXT,
			edited_at TEXT,
			idle_snoozed_until TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_board_tasks_board_status ON board_tasks(board_id, status);
		CREATE INDEX IF NOT EXISTS idx_board_tasks_assigned ON board_tasks(board_id, assigned_to);
		-- The task list pages done tasks newest first (ListTaskPage, #3269). The WHERE clause
		-- must stay identical to doneTaskStatusSQL for SQLite to use this partial index.
		CREATE INDEX IF NOT EXISTS idx_board_tasks_done ON board_tasks(board_id, completed_at, id)
			WHERE status IN ('completed', 'skipped');
		-- The Analytics view's efficiency read lists the tasks completed in a window across every board (#8999): the board id is not in its WHERE.
		CREATE INDEX IF NOT EXISTS idx_board_tasks_completed_at ON board_tasks(completed_at) WHERE status = 'completed';
		CREATE TABLE IF NOT EXISTS task_amendments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id INTEGER NOT NULL REFERENCES board_tasks(id),
			revision INTEGER NOT NULL,
			actor TEXT NOT NULL,
			created_at TEXT NOT NULL,
			reason TEXT NOT NULL,
			changes_json TEXT NOT NULL,
			previous_snapshot_json TEXT NOT NULL,
			effective_snapshot_json TEXT NOT NULL,
			UNIQUE(task_id, revision)
		);
	`)
	if err != nil {
		return err
	}
	return nil
}

func (s *Store) createBoardTaskDependencies(ctx context.Context) error {
	// Task dependencies table
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS task_dependencies (
			task_id INTEGER NOT NULL,
			blocked_by_task_id INTEGER NOT NULL,
			blocked_by_board_id TEXT NOT NULL,
			PRIMARY KEY (task_id, blocked_by_task_id),
			FOREIGN KEY (task_id) REFERENCES board_tasks(id),
			FOREIGN KEY (blocked_by_task_id) REFERENCES board_tasks(id)
		);
		CREATE INDEX IF NOT EXISTS idx_task_deps_blocked_by ON task_dependencies(blocked_by_task_id);
	`)
	if err != nil {
		return err
	}
	return nil
}
