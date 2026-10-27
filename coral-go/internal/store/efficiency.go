package store

import (
	"context"
	"time"
)

// Reads for the Analytics view's efficiency measures (#8915): the usage of a window by session, model and thinking level; the commits agents recorded in it; and each session's latest branch. The
// grouping and the sums are internal/efficiency's.

// EfficiencyUsageRow is the tokens (input + output) and cost of one session at one model and thinking level in a window. Team is the board the row was recorded on, else the session's own.
type EfficiencyUsageRow struct {
	SessionID string  `db:"session_id"`
	AgentName string  `db:"agent_name"`
	AgentType string  `db:"agent_type"`
	Team      string  `db:"team"`
	Model     string  `db:"model"`
	Thinking  string  `db:"thinking"`
	Tokens    int64   `db:"tokens"`
	CostUSD   float64 `db:"cost_usd"`
}

// EfficiencyUsage reads the usage recorded in [since, until) (RFC 3339 UTC, until "" for no end): raw rows and rolled-up hourly rows alike, a session counted once however it was read (the same rule
// as every other usage total). A row with no model or no thinking level has "" there.
func (s *TokenUsageStore) EfficiencyUsage(ctx context.Context, since, until string) ([]EfficiencyUsageRow, error) {
	q := `SELECT t.session_id, COALESCE(NULLIF(ls.display_name, ''), MIN(t.agent_name), '') AS agent_name, t.agent_type,
	             COALESCE(NULLIF(t.board_name, ''), ls.board_name, '') AS team, COALESCE(t.model, '') AS model, COALESCE(t.thinking, '') AS thinking,
	             COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens, COALESCE(SUM(t.cost_usd), 0) AS cost_usd
	      FROM token_usage_all t LEFT JOIN live_sessions ls ON ls.session_id = t.session_id
	      WHERE ` + usageDedup("t.") + ` AND t.recorded_at >= ?`
	args := []any{windowBound(since)}
	if until != "" {
		q += ` AND t.recorded_at < ?`
		args = append(args, windowBound(until))
	}
	// the grouping is by the usage row's own columns: the live session has a model and a thinking level of its own, which are not these
	q += ` GROUP BY t.session_id, t.agent_type, COALESCE(NULLIF(t.board_name, ''), ls.board_name, ''), COALESCE(t.model, ''), COALESCE(t.thinking, '')
	       ORDER BY t.session_id, COALESCE(t.model, ''), COALESCE(t.thinking, '')`
	var rows []EfficiencyUsageRow
	err := s.db.Reader().SelectContext(ctx, &rows, q, args...)
	return rows, err
}

// EfficiencyCommit is a commit, with the session that recorded it first.
type EfficiencyCommit struct {
	Hash      string
	SessionID string
	AgentName string
	AgentType string
	Branch    string
	At        time.Time // the commit's own time
}

// EfficiencyCommits lists the commits whose own time is in [since, until), one per commit hash, attributed to the session whose snapshot of it was recorded first. A snapshot with no session, or with
// no commit time that parses, is not a commit anyone made in the window and is left out.
func (s *SessionStore) EfficiencyCommits(ctx context.Context, since, until time.Time) ([]EfficiencyCommit, error) {
	// recorded_at moves forward on the newest snapshot of a session at every poll, so it is never before the commit: a snapshot recorded before the window cannot hold a commit of it.
	var rows []struct {
		ID        int64   `db:"id"`
		Hash      string  `db:"commit_hash"`
		SessionID string  `db:"session_id"`
		AgentName string  `db:"agent_name"`
		AgentType string  `db:"agent_type"`
		Branch    string  `db:"branch"`
		At        *string `db:"commit_timestamp"`
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, `SELECT id, commit_hash, session_id, agent_name, agent_type, branch, commit_timestamp FROM git_snapshots
		WHERE session_id IS NOT NULL AND session_id != '' AND commit_timestamp IS NOT NULL AND recorded_at >= ? ORDER BY id`, since.UTC().Format(ISOFormat)); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []EfficiencyCommit
	for _, r := range rows {
		if r.At == nil || seen[r.Hash] {
			continue
		}
		at, err := time.Parse(time.RFC3339, *r.At)
		if err != nil {
			continue
		}
		seen[r.Hash] = true // the first snapshot of a hash is the one that counts, in or out of the window
		if at.Before(since) || !at.Before(until) {
			continue
		}
		out = append(out, EfficiencyCommit{Hash: r.Hash, SessionID: r.SessionID, AgentName: r.AgentName, AgentType: r.AgentType, Branch: r.Branch, At: at.UTC()})
	}
	return out, nil
}

// LatestBranches is each session's most recent branch (the one its newest snapshot names), as the By branch read attributes a session's tokens.
func (s *SessionStore) LatestBranches(ctx context.Context) (map[string]string, error) {
	var rows []struct {
		SessionID string `db:"session_id"`
		Branch    string `db:"branch"`
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, `SELECT session_id, branch FROM git_snapshots WHERE session_id IS NOT NULL AND session_id != ''
		AND id IN (SELECT MAX(id) FROM git_snapshots WHERE session_id IS NOT NULL GROUP BY session_id)`); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.SessionID] = r.Branch
	}
	return out, nil
}
