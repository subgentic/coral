package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

// The Operator's "Keep Full access when this agent restarts" choice for a Codex agent (#14061). It is a record only: what a relaunch does with it is the launch builder's (agent.LaunchParams.KeepFullAccess),
// and who may set it is the route's (an Operator, never an agent token). A row in keep_full_access is the choice being on.

// KeepFullAccess says whether the choice is on for the session.
func (s *SessionStore) KeepFullAccess(ctx context.Context, sessionID string) (bool, error) {
	var n int
	err := s.reader().QueryRowContext(ctx, `SELECT 1 FROM keep_full_access WHERE session_id = ?`, sessionID).Scan(&n)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// SetKeepFullAccess turns the choice on or off and says whether that changed anything, so the caller logs a change once and not a repeat.
func (s *SessionStore) SetKeepFullAccess(ctx context.Context, sessionID string, on bool) (changed bool, err error) {
	var res sql.Result
	if on {
		res, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO keep_full_access (session_id, set_at) VALUES (?, ?)`, sessionID, time.Now().Unix())
	} else {
		res, err = s.db.ExecContext(ctx, `DELETE FROM keep_full_access WHERE session_id = ?`, sessionID)
	}
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// KeepFullAccessSessions is every session with the choice on, for the live list (a reader: the list never waits for the writer).
func (s *SessionStore) KeepFullAccessSessions(ctx context.Context) (map[string]bool, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id FROM keep_full_access`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// carryKeepFullAccessTx moves the choice from a replaced session to its new one, unless the new row's capabilities are an edit of the old one's (the person changed what the agent may do on purpose: a
// choice made before that does not outlive it). It always ends with none on the old session.
func carryKeepFullAccessTx(ctx context.Context, tx *sqlx.Tx, oldID, newID string, oldCaps, newCaps *string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM keep_full_access WHERE session_id = ?`, oldID).Scan(&n)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM keep_full_access WHERE session_id = ?`, oldID); err != nil {
		return err
	}
	if newCaps != nil && ptrValue(newCaps) != ptrValue(oldCaps) {
		return nil // edited capabilities: cleared
	}
	_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO keep_full_access (session_id, set_at) VALUES (?, ?)`, newID, time.Now().Unix())
	return err
}

func ptrValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
