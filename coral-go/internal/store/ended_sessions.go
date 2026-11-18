package store

import (
	"context"
	"sort"
)

// EndedSession is an agent that was ended (Kill All, or it exited and Coral stopped its row) and has no running or sleeping session on its board now: what Wake Team can offer to resume (#14208).
type EndedSession struct {
	SessionID  string `db:"session_id" json:"session_id"`
	AgentType  string `db:"agent_type" json:"agent_type"`
	Name       string `db:"name" json:"name"`
	WorkingDir string `db:"working_dir" json:"-"`
	StoppedAt  string `db:"stopped_at" json:"-"`
	Order      int64  `db:"ord" json:"-"`
}

// EndedSessionsOnBoard is the agents of a board that were ended and not started again, one per name: the ended row with the latest stop, listed in the order the sessions were first registered. A name that has an active session on the board (it was
// restarted or resumed, or woke) is not in it, and neither are archived agents or jobs.
func (s *SessionStore) EndedSessionsOnBoard(ctx context.Context, board string) ([]EndedSession, error) {
	if board == "" {
		return nil, nil
	}
	var rows []EndedSession
	err := s.reader().SelectContext(ctx, &rows, `
		SELECT session_id, agent_type, COALESCE(NULLIF(display_name, ''), agent_name) AS name, working_dir, stopped_at, rowid AS ord
		FROM live_sessions
		WHERE status = 'inactive' AND board_name = ? AND is_archived = 0 AND is_job = 0 AND stopped_at IS NOT NULL
		  AND COALESCE(NULLIF(display_name, ''), agent_name) NOT IN (
		      SELECT COALESCE(NULLIF(display_name, ''), agent_name) FROM live_sessions WHERE status = 'active' AND board_name = ?)
		ORDER BY stopped_at DESC, rowid DESC`, board, board)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := rows[:0]
	for _, r := range rows {
		if seen[r.Name] {
			continue
		}
		seen[r.Name] = true
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Order < out[j].Order }) // in the order the team was started (Lead, Dev, QA), not the order Kill All ended them
	return out, nil
}

// ReviveEndedSession turns an ended agent's row (inactive, with a stop time) into a sleeping one, so a Start wakes it like any sleeper: its resume info is the row's own (#19696). It refuses, reporting false, when the row is not ended
// or another active session of the same board already has the name (the agent was started again): a team's names are unique.
func (s *SessionStore) ReviveEndedSession(ctx context.Context, sessionID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE live_sessions SET status = 'active', stopped_at = NULL, is_sleeping = 1, is_archived = 0
		WHERE session_id = ? AND status = 'inactive' AND stopped_at IS NOT NULL AND is_job = 0
		  AND NOT EXISTS (SELECT 1 FROM live_sessions o WHERE o.status = 'active' AND o.session_id <> live_sessions.session_id
		                  AND COALESCE(o.board_name, '') = COALESCE(live_sessions.board_name, '')
		                  AND COALESCE(NULLIF(o.display_name, ''), o.agent_name) = COALESCE(NULLIF(live_sessions.display_name, ''), live_sessions.agent_name))`, sessionID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
