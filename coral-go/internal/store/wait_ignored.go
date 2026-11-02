package store

import (
	"context"
	"time"
)

// SetWaitIgnored records that the Operator hid this agent's current request (named by key) from Needs you (#11946). One row per agent: the next hidden request replaces it. It also removes the rows of agents that
// are no longer live (ended, stopped, replaced by a restart, deleted: no active live_sessions row), so the table holds a row only for an agent that exists and never grows for ever (#11979); a sleeping agent is
// live and keeps its row.
func (s *SessionStore) SetWaitIgnored(ctx context.Context, sessionID, requestKey string) error {
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agent_wait_ignored(session_id, request_key, ignored_at) VALUES(?,?,?)
 ON CONFLICT(session_id) DO UPDATE SET request_key=excluded.request_key, ignored_at=excluded.ignored_at`, sessionID, requestKey, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM agent_wait_ignored WHERE session_id != ? AND session_id NOT IN (SELECT session_id FROM live_sessions WHERE status = 'active')`, sessionID)
	return err
}

// WaitIgnoredKeys is {session id: the request key the Operator hid}, for every agent that has one: read once per live list.
func (s *SessionStore) WaitIgnoredKeys(ctx context.Context) (map[string]string, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id, request_key FROM agent_wait_ignored`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, key string
		if err := rows.Scan(&id, &key); err != nil {
			return nil, err
		}
		out[id] = key
	}
	return out, rows.Err()
}
