package store

import (
	"context"
	"time"
)

// SetWaitIgnored records that the Operator hid this agent's current request (named by key) from Needs you (#11946). One row per agent: the next hidden request replaces it.
func (s *SessionStore) SetWaitIgnored(ctx context.Context, sessionID, requestKey string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_wait_ignored(session_id, request_key, ignored_at) VALUES(?,?,?)
 ON CONFLICT(session_id) DO UPDATE SET request_key=excluded.request_key, ignored_at=excluded.ignored_at`, sessionID, requestKey, time.Now().UTC().Format(time.RFC3339))
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
