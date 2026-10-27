package board

import (
	"context"
	"fmt"
	"log"
)

// board_message_counts is the number of messages each board holds (#9503). GET /api/board/projects asked for it with a COUNT(*) per board and a DISTINCT over every message to list
// the boards that have any, so the poll cost the size of the message history (4.9 ms on 50,000 messages, for a 389-byte answer). The table is derived data: triggers on board_messages
// keep it in step with every insert, delete (a project delete is one) and move of a message to another board, by any writer of any version, and every open recounts it against the
// messages and repairs and logs a difference, so a drift cannot last past a restart.

const messageCountsSQL = `
CREATE TABLE IF NOT EXISTS board_message_counts (project TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS board_message_counts_ai AFTER INSERT ON board_messages BEGIN
	INSERT INTO board_message_counts (project, n) VALUES (NEW.project, 1) ON CONFLICT (project) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS board_message_counts_ad AFTER DELETE ON board_messages BEGIN
	UPDATE board_message_counts SET n = n - 1 WHERE project = OLD.project;
	DELETE FROM board_message_counts WHERE project = OLD.project AND n <= 0;
END;
CREATE TRIGGER IF NOT EXISTS board_message_counts_au AFTER UPDATE OF project ON board_messages WHEN OLD.project IS NOT NEW.project BEGIN
	UPDATE board_message_counts SET n = n - 1 WHERE project = OLD.project;
	DELETE FROM board_message_counts WHERE project = OLD.project AND n <= 0;
	INSERT INTO board_message_counts (project, n) VALUES (NEW.project, 1) ON CONFLICT (project) DO UPDATE SET n = n + 1;
END;
`

// ensureMessageCounts creates the table and its triggers and makes the counts right: built from the messages when the table is new, recounted and repaired (and logged) when it
// exists and differs. One write transaction, so no message can land between the recount and the triggers being in place.
func (s *Store) ensureMessageCounts(ctx context.Context) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existed int
	if err := tx.GetContext(ctx, &existed, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'board_message_counts'`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, messageCountsSQL); err != nil {
		return fmt.Errorf("create board message counts: %w", err)
	}
	var wrong int
	if err := tx.GetContext(ctx, &wrong, `SELECT COUNT(*) FROM (
		SELECT m.project FROM (SELECT project, COUNT(*) AS n FROM board_messages GROUP BY project) m LEFT JOIN board_message_counts c ON c.project = m.project WHERE c.n IS NOT m.n
		UNION ALL
		SELECT c.project FROM board_message_counts c WHERE NOT EXISTS (SELECT 1 FROM board_messages WHERE project = c.project))`); err != nil {
		return err
	}
	if wrong > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM board_message_counts`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_message_counts (project, n) SELECT project, COUNT(*) FROM board_messages GROUP BY project`); err != nil {
			return err
		}
		if existed > 0 {
			log.Printf("board: repaired the message counts of %d board(s): they did not match the messages", wrong)
		}
	}
	return tx.Commit()
}
