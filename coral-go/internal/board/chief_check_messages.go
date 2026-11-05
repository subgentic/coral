package board

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PostChiefCheckMessage commits a normal system board message with its dedupe key.
// The caller has verified the exact target and cleaned/defused all quoted text.
func (s *Store) PostChiefCheckMessage(ctx context.Context, project string, triggerID int64, deliveryKey, kind, content string) (int64, error) {
	if len(deliveryKey) != 32 || triggerID <= 0 || (kind != "delivery" && kind != "reminder") {
		return 0, errors.New("invalid check delivery")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id int64
	err = tx.GetContext(ctx, &id, `SELECT message_id FROM chief_check_messages WHERE trigger_key=? AND kind=? AND project=?`, deliveryKey, kind, project)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var n int
	if err = tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM chief_check_messages`); err != nil {
		return 0, err
	}
	if n >= 20000 {
		return 0, errors.New("check delivery history is full")
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO board_messages(project,session_id,subscriber_id,content,created_at,is_system) VALUES(?,?,?,?,?,1)`, project, "Coral Task Queue", "Coral Task Queue", content, nowUTC())
	if err != nil {
		return 0, err
	}
	id, _ = res.LastInsertId()
	_, err = tx.ExecContext(ctx, `INSERT INTO chief_check_messages(trigger_id,trigger_key,kind,project,message_id,created_at) VALUES(?,?,?,?,?,?)`, triggerID, deliveryKey, kind, project, id, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

type ChiefDeliveryKey struct {
	TriggerID int64  `db:"trigger_id"`
	Key       string `db:"trigger_key"`
}

func (s *Store) OldChiefDeliveryKeys(ctx context.Context, cut int64) ([]ChiefDeliveryKey, error) {
	ids := []ChiefDeliveryKey{}
	err := s.reader().SelectContext(ctx, &ids, `SELECT DISTINCT trigger_id,trigger_key FROM chief_check_messages WHERE created_at<? ORDER BY trigger_id LIMIT 100`, cut)
	return ids, err
}
func (s *Store) ForgetChiefDeliveryKey(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM chief_check_messages WHERE trigger_key=?`, key)
	return err
}

// RecordMessageSession attributes a post to its verified session, not a reusable role.
func (s *Store) RecordMessageSession(ctx context.Context, project string, id int64, sid string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_message_sessions(message_id,project,session_id) SELECT id,project,? FROM board_messages WHERE id=? AND project=? ON CONFLICT(message_id) DO NOTHING`, sid, id, project)
	return err
}
func (s *Store) MessageSession(ctx context.Context, project string, id int64) (string, error) {
	var sid string
	err := s.reader().GetContext(ctx, &sid, `SELECT session_id FROM board_message_sessions WHERE message_id=? AND project=?`, id, project)
	return sid, err
}
