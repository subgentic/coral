package board

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// One file for review per task chain, not per file name (#12144): a feature and its follow-up were two separate "done" files, and a series must not depend on file names. An upload linked to a task joins the
// series of that task's chain, keyed by the chain's ROOT task (a follow-up points to its parent, and the server walks up with a depth bound). The chain's latest file is remembered here; while it is still open for
// review, the next upload for the chain becomes its next version, so the Operator reviews one file that grows and a decision on it covers the whole chain.

// maxChainDepth bounds the walk up a task's parents.
const maxChainDepth = 20

func (s *Store) ensureArtifactChainsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_task_chains (
		board_id  TEXT NOT NULL,
		root_task INTEGER NOT NULL,
		hex       TEXT NOT NULL,
		set_at    TEXT NOT NULL,
		PRIMARY KEY (board_id, root_task)
	)`)
	return err
}

// RootTask is the root of the chain a task of the board belongs to: the task itself, or the top of its follow-up parents (at most maxChainDepth steps, and never off the board). A task that cannot be read is its
// own root.
func (s *Store) RootTask(ctx context.Context, boardID string, taskID int64) int64 {
	cur := taskID
	for i := 0; i < maxChainDepth; i++ {
		var parent int64
		err := s.reader().GetContext(ctx, &parent, `SELECT COALESCE(w.lst_parent, 0) FROM task_workflows w JOIN board_tasks t ON t.id = w.task_id WHERE t.board_id = ? AND w.task_id = ?`, boardID, cur)
		if err != nil || parent <= 0 || parent == cur {
			return cur
		}
		var onBoard int
		if err := s.reader().GetContext(ctx, &onBoard, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND id = ?`, boardID, parent); err != nil || onBoard == 0 {
			return cur
		}
		cur = parent
	}
	return cur
}

// ChainFile is the latest file for review remembered for the chain, "" for none.
func (s *Store) ChainFile(ctx context.Context, boardID string, root int64) string {
	var hex string
	if err := s.reader().GetContext(ctx, &hex, `SELECT hex FROM artifact_task_chains WHERE board_id = ? AND root_task = ?`, boardID, root); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return ""
		}
		return ""
	}
	return hex
}

// SetChainFile remembers hex as the chain's latest file for review.
func (s *Store) SetChainFile(ctx context.Context, boardID string, root int64, hex string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO artifact_task_chains (board_id, root_task, hex, set_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(board_id, root_task) DO UPDATE SET hex = excluded.hex, set_at = excluded.set_at`, boardID, root, hex, at.UTC().Format(time.RFC3339))
	return err
}

// ChainEntry is a file remembered for a task of a chain, and the task it is remembered under.
type ChainEntry struct {
	Task int64
	Hex  string
}

// ChainFilesNear are the files remembered for the task itself and for each of its follow-up parents up the chain (nearest first, at most maxChainDepth steps, never off the board). A file is remembered under the
// task that made it (#13908): a task joins the file of its own line (itself, its parent, its parent's parent), and two follow-ups of one parent, which are different deliverables, no longer share one.
func (s *Store) ChainFilesNear(ctx context.Context, boardID string, taskID int64) []ChainEntry {
	var out []ChainEntry
	cur := taskID
	for i := 0; i < maxChainDepth && cur > 0; i++ {
		if hex := s.ChainFile(ctx, boardID, cur); hex != "" {
			out = append(out, ChainEntry{Task: cur, Hex: hex})
		}
		var parent int64
		err := s.reader().GetContext(ctx, &parent, `SELECT COALESCE(w.lst_parent, 0) FROM task_workflows w JOIN board_tasks t ON t.id = w.task_id WHERE t.board_id = ? AND w.task_id = ?`, boardID, cur)
		if err != nil || parent <= 0 || parent == cur {
			break
		}
		var onBoard int
		if err := s.reader().GetContext(ctx, &onBoard, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND id = ?`, boardID, parent); err != nil || onBoard == 0 {
			break
		}
		cur = parent
	}
	return out
}
