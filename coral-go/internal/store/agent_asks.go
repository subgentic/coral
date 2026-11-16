package store

import (
	"context"
	"encoding/json"
	"time"
)

// AgentAsk is a question a single agent asked the Operator (#18106).
type AgentAsk struct {
	ID          int64
	SessionID   string
	SessionName string
	Text        string
	Options     []string
	CreatedAt   string
}

// CreateAgentAsk records a question; an agent has at most one open at a time: a newer one replaces its older (the older is closed unanswered).
func (s *SessionStore) CreateAgentAsk(ctx context.Context, sessionID, sessionName, text string, options []string, now time.Time) (int64, error) {
	at := now.UTC().Format(ISOFormat)
	if _, err := s.db.ExecContext(ctx, `UPDATE agent_asks SET answered_at = ? WHERE session_id = ? AND answered_at IS NULL`, at, sessionID); err != nil {
		return 0, err
	}
	if options == nil {
		options = []string{}
	}
	raw, _ := json.Marshal(options)
	res, err := s.db.ExecContext(ctx, `INSERT INTO agent_asks (session_id, session_name, text, options, created_at) VALUES (?, ?, ?, ?, ?)`, sessionID, sessionName, text, string(raw), at)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func scanAgentAsks(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]AgentAsk, error) {
	var out []AgentAsk
	for rows.Next() {
		var a AgentAsk
		var opts string
		if err := rows.Scan(&a.ID, &a.SessionID, &a.SessionName, &a.Text, &opts, &a.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(opts), &a.Options)
		out = append(out, a)
	}
	return out, rows.Err()
}

// OpenAgentAsks lists the unanswered questions, oldest first.
func (s *SessionStore) OpenAgentAsks(ctx context.Context) ([]AgentAsk, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, session_id, session_name, text, options, created_at FROM agent_asks WHERE answered_at IS NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAgentAsks(rows)
}

// OpenAgentAsk is one open question, or nil.
func (s *SessionStore) OpenAgentAsk(ctx context.Context, id int64) (*AgentAsk, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, session_id, session_name, text, options, created_at FROM agent_asks WHERE id = ? AND answered_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list, err := scanAgentAsks(rows)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

// ReopenAgentAsk puts back a question that was claimed for an answer which then could not be delivered (#18667): it is the Operator's again. Never one that was dismissed (that is Undo's, below).
func (s *SessionStore) ReopenAgentAsk(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_asks SET answered_at = NULL WHERE id = ? AND dismissed_at IS NULL`, id)
	return err
}

// DismissAgentAsk closes a question as dismissed; false when it was not open.
func (s *SessionStore) DismissAgentAsk(ctx context.Context, id int64, now time.Time) (bool, error) {
	at := now.UTC().Format(ISOFormat)
	res, err := s.db.ExecContext(ctx, `UPDATE agent_asks SET answered_at = ?, dismissed_at = ? WHERE id = ? AND answered_at IS NULL`, at, at, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return err == nil && n == 1, err
}

// UndoDismissAgentAsk puts back a question the Operator dismissed (#18714): an answered one, or one closed because its agent exited, stays closed (a second answer would be typed into the agent twice).
// False when it was not dismissed, or the agent has asked something newer since.
func (s *SessionStore) UndoDismissAgentAsk(ctx context.Context, id int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE agent_asks SET answered_at = NULL, dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM agent_asks n WHERE n.session_id = agent_asks.session_id AND n.id > agent_asks.id AND n.answered_at IS NULL)`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return err == nil && n == 1, err
}

// CloseAgentAsk marks a question answered; false when it was not open (another answer got there first).
func (s *SessionStore) CloseAgentAsk(ctx context.Context, id int64, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE agent_asks SET answered_at = ? WHERE id = ? AND answered_at IS NULL`, now.UTC().Format(ISOFormat), id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return err == nil && n == 1, err
}
