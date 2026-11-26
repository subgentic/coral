package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// TaskWorktree is the worktree a worker was started in with its own flag (#21468: "worker launch --worktree"): the one folder that "worker archive --remove-worktree" may remove, kept apart from the worktrees of
// teams and the ones a person made in New agent, so the flag does something only for a worker that asked for it.
type TaskWorktree struct {
	SessionID string `db:"session_id" json:"session_id"`
	TaskID    int64  `db:"task_id" json:"task_id"`
	Name      string `db:"name" json:"name"` // the folder and branch name: task-N
	Path      string `db:"path" json:"-"`
	Repo      string `db:"repo" json:"-"`
	CreatedAt string `db:"created_at" json:"created_at"`
}

// SetTaskWorktree records the worktree a worker was started in.
func (s *SessionStore) SetTaskWorktree(ctx context.Context, w TaskWorktree) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO task_worktrees (session_id, task_id, name, path, repo, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		w.SessionID, w.TaskID, w.Name, w.Path, w.Repo, time.Now().UTC().Format(time.RFC3339))
	return err
}

// GetTaskWorktree is a worker's own worktree, or nil when it was not started with one.
func (s *SessionStore) GetTaskWorktree(ctx context.Context, sessionID string) (*TaskWorktree, error) {
	var w TaskWorktree
	err := s.reader().GetContext(ctx, &w, `SELECT session_id, task_id, name, path, repo, created_at FROM task_worktrees WHERE session_id = ?`, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// TaskWorktreeNames maps session ids to their own worktree's name, for the sessions list (the header chip).
func (s *SessionStore) TaskWorktreeNames(ctx context.Context) (map[string]string, error) {
	var rows []struct {
		SessionID string `db:"session_id"`
		Name      string `db:"name"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT session_id, name FROM task_worktrees`); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.SessionID] = r.Name
	}
	return out, nil
}

// OtherLiveInPath counts the sessions other than sessionID that are active and work in path: a worktree somebody still works in is not removed.
func (s *SessionStore) OtherLiveInPath(ctx context.Context, sessionID, path string) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM live_sessions WHERE session_id != ? AND status = 'active' AND is_sleeping = 0 AND (working_dir = ? OR worktree_path = ?)`, sessionID, path, path)
	return n, err
}
