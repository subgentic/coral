package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// SleepReasonIdle: Coral put the agent to sleep because it had been idle for the Operator's minutes (#12111). It is "auto-asleep": the lists show it as available and any
// delivery from Coral wakes it. The person's own Sleep is reason "" and never becomes this.
const SleepReasonIdle = "idle"

// AutoSleepState is one agent's part of auto-sleep: the Operator's per-agent opt-out, and the two clocks of the thrash guard (unix seconds; 0 is never).
type AutoSleepState struct {
	Off     bool
	SleptAt int64
	WokenAt int64
	// FirstTurnLogged: the first turn after the last auto-wake was measured and logged (#12111).
	FirstTurnLogged bool
}

// AutoSleepStateOf reads it; an agent with no row has the zero state (auto-sleep on, nothing recorded).
func (s *SessionStore) AutoSleepStateOf(ctx context.Context, sessionID string) (AutoSleepState, error) {
	var off, logged int
	var slept, woken sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT off, slept_at, woken_at, first_turn_logged FROM auto_sleep_state WHERE session_id = ?`, sessionID).Scan(&off, &slept, &woken, &logged)
	if errors.Is(err, sql.ErrNoRows) {
		return AutoSleepState{}, nil
	}
	return AutoSleepState{Off: off == 1, SleptAt: slept.Int64, WokenAt: woken.Int64, FirstTurnLogged: logged == 1}, err
}

// SetAutoSleepOff sets the Operator's opt-out for one agent.
func (s *SessionStore) SetAutoSleepOff(ctx context.Context, sessionID string, off bool) error {
	v := 0
	if off {
		v = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO auto_sleep_state (session_id, off) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET off = excluded.off`, sessionID, v)
	return err
}

// SetSessionAutoSleeping is the auto-sleep itself in one transaction: the row is asleep with the reason idle and the sleep clock is written, so a crash leaves both or neither.
func (s *SessionStore) SetSessionAutoSleeping(ctx context.Context, sessionID string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE live_sessions SET is_sleeping = 1, sleep_reason = ? WHERE session_id = ? AND is_sleeping = 0 AND is_archived = 0`, SleepReasonIdle, sessionID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows // it is not awake any more (a person's Sleep, or a stop, came first): nothing is recorded
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO auto_sleep_state (session_id, slept_at, woken_at) VALUES (?, ?, NULL) ON CONFLICT(session_id) DO UPDATE SET slept_at = excluded.slept_at, woken_at = NULL`, sessionID, at.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// NoteAutoWoken records that a delivery woke an auto-asleep agent (the thrash guard's second clock).
func (s *SessionStore) NoteAutoWoken(ctx context.Context, sessionID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE auto_sleep_state SET woken_at = ?, first_turn_logged = 0 WHERE session_id = ?`, at.Unix(), sessionID)
	return err
}

// ClearAutoSleepClocks forgets both clocks: a person's Sleep or Wake is theirs and resets the guard. The opt-out stays.
func (s *SessionStore) ClearAutoSleepClocks(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE auto_sleep_state SET slept_at = NULL, woken_at = NULL, first_turn_logged = 0 WHERE session_id = ?`, sessionID)
	return err
}

// MarkAutoFirstTurnLogged records that the first turn after the last auto-wake was measured, so it is logged once.
func (s *SessionStore) MarkAutoFirstTurnLogged(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE auto_sleep_state SET first_turn_logged = 1 WHERE session_id = ?`, sessionID)
	return err
}

// AutoSleepOffSessions is the set of sessions the Operator opted out of auto-sleep, for the live list's menu wording.
func (s *SessionStore) AutoSleepOffSessions(ctx context.Context) (map[string]bool, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id FROM auto_sleep_state WHERE off = 1`) // a reader: the live list never waits for the writer
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			return nil, err
		}
		out[sid] = true
	}
	return out, rows.Err()
}
