package board

import (
	"context"
	"time"
)

// What an agent added to a team was told about (#17343, after #17305): when Add agent launches onto a team the Orchestrator is sent a board notice, and the team page's Agents row says whether
// the team was told. A row holds the notice's message id, or 0 when there was nobody to tell (the team has no Orchestrator). Whether the Orchestrator has read it is read from its own read mark.

// RecordJoinNotice keeps the notice sent about subscriber (messageID, or 0 for none sent).
func (s *Store) RecordJoinNotice(ctx context.Context, project, subscriber string, messageID int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_join_notices(project,subscriber_id,message_id,created_at) VALUES(?,?,?,?)
		ON CONFLICT(project,subscriber_id) DO UPDATE SET message_id=excluded.message_id, created_at=excluded.created_at`, project, subscriber, messageID, time.Now().UTC().Format(time.RFC3339))
	return err
}

// JoinNoticeStates is, for each agent of the board that has a recorded notice, whether the team was told ("told") or not yet ("not_told": no notice was sent, or the Orchestrator has not read it).
func (s *Store) JoinNoticeStates(ctx context.Context, project, orchestrator string) (map[string]string, error) {
	var rows []struct {
		SubscriberID string `db:"subscriber_id"`
		MessageID    int64  `db:"message_id"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT subscriber_id, message_id FROM board_join_notices WHERE project = ?`, project); err != nil || len(rows) == 0 {
		return nil, err
	}
	var read int64
	if orchestrator != "" {
		_ = s.reader().GetContext(ctx, &read, `SELECT COALESCE(MAX(last_read_id), 0) FROM board_subscribers WHERE project = ? AND subscriber_id = ? AND is_active = 1`, project, orchestrator)
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.SubscriberID] = "not_told"
		if r.MessageID > 0 && read >= r.MessageID {
			out[r.SubscriberID] = "told"
		}
	}
	return out, nil
}
