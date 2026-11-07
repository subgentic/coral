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

// The two places a choice can have been made (#14193).
const (
	KeepSourceLocal = "local"
	KeepSourceHub   = "hub"
)

// SetKeepFullAccess turns the choice on or off as a local one: see SetKeepFullAccessFrom.
func (s *SessionStore) SetKeepFullAccess(ctx context.Context, sessionID string, on bool) (changed bool, err error) {
	return s.SetKeepFullAccessFrom(ctx, sessionID, on, KeepSourceLocal)
}

// SetKeepFullAccessFrom turns the choice on or off and says whether that changed anything, so the caller logs a change once and not a repeat. source is where the request came from: a hub-made choice ends
// when the hub's switch goes off or its mode is lowered (ClearHubKeepFullAccess); one made locally never does, and a local on over a hub one makes it local, so the Operator's own choice outlives the hub's switch.
func (s *SessionStore) SetKeepFullAccessFrom(ctx context.Context, sessionID string, on bool, source string) (changed bool, err error) {
	if source != KeepSourceHub {
		source = KeepSourceLocal
	}
	var res sql.Result
	if on {
		res, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO keep_full_access (session_id, set_at, source) VALUES (?, ?, ?)`, sessionID, time.Now().Unix(), source)
		if err == nil && source == KeepSourceLocal {
			_, err = s.db.ExecContext(ctx, `UPDATE keep_full_access SET source = 'local' WHERE session_id = ? AND source != 'local'`, sessionID)
		}
	} else {
		res, err = s.db.ExecContext(ctx, `DELETE FROM keep_full_access WHERE session_id = ?`, sessionID)
	}
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// ClearHubKeepFullAccess ends every choice the hub made and says how many: the hub's "can turn on auto-accept" switch went off, or its mode was lowered below Launch (#14193). A choice made locally stays.
func (s *SessionStore) ClearHubKeepFullAccess(ctx context.Context) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM keep_full_access WHERE source = 'hub'`)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
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
	var source string
	err := tx.QueryRowContext(ctx, `SELECT source FROM keep_full_access WHERE session_id = ?`, oldID).Scan(&source)
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
	_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO keep_full_access (session_id, set_at, source) VALUES (?, ?, ?)`, newID, time.Now().Unix(), source) // the new session keeps where the choice came from
	return err
}

func ptrValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
