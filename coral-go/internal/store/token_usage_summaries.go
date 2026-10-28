// The token usage summaries: by session, team and board, by model, by agent (and board), and by branch. Moved out of token_usage.go (#8296), no code changed.

package store

import (
	"context"
	"database/sql"
	"sort"

	"github.com/subgentic/coral/internal/clitext"
)

// GetSessionUsage returns aggregated token usage for a session (sum of all per-turn records).
// GetSessionUsage has no production caller: it is exported for the retention test in internal/background.
func (s *TokenUsageStore) GetSessionUsage(ctx context.Context, sessionID string) (*TokenUsage, error) {
	var u TokenUsage
	err := s.db.Reader().GetContext(ctx, &u,
		`SELECT MAX(id) as id, session_id, MAX(agent_name) as agent_name, MAX(agent_type) as agent_type,
		 MAX(team_id) as team_id, MAX(board_name) as board_name,
		 COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens,
		 COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
		 COALESCE(SUM(total_tokens), 0) as total_tokens, COALESCE(SUM(cost_usd), 0) as cost_usd,
		 SUM(n_rows) as num_turns,
		 COALESCE(MIN(session_start_at), '') as session_start_at,
		 COALESCE(MAX(last_activity_at), '') as last_activity_at,
		 CASE WHEN MIN(NULLIF(session_start_at, '')) IS NOT NULL AND MAX(NULLIF(last_activity_at, '')) IS NOT NULL
		      THEN MAX(0, CAST(ROUND((julianday(MAX(NULLIF(last_activity_at, ''))) - julianday(MIN(NULLIF(session_start_at, '')))) * 86400) AS INTEGER))
		      ELSE 0 END as execution_time_sec,
		 MAX(recorded_at) as recorded_at
		 FROM token_usage_all WHERE session_id = ? AND `+sourceDedup+` GROUP BY session_id`, sessionID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// getTeamUsage returns aggregated token usage for a team (sum of all per-turn records).
func (s *TokenUsageStore) getTeamUsage(ctx context.Context, teamID int64) (*UsageSummary, error) {
	var summary UsageSummary
	err := s.db.Reader().GetContext(ctx, &summary,
		`SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
		        COALESCE(SUM(output_tokens), 0) as output_tokens,
		        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
		        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
		        COALESCE(SUM(total_tokens), 0) as total_tokens,
		        COALESCE(SUM(cost_usd), 0) as cost_usd,
		        COUNT(DISTINCT session_id) as num_sessions
		 FROM token_usage_all WHERE team_id = ? AND `+sourceDedup, teamID)
	if err != nil {
		return nil, err
	}
	return &summary, nil
}

// getBoardUsage returns aggregated token usage for a board (sum of all per-turn records).
func (s *TokenUsageStore) getBoardUsage(ctx context.Context, boardName string) (*UsageSummary, error) {
	var summary UsageSummary
	err := s.db.Reader().GetContext(ctx, &summary,
		`SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
		        COALESCE(SUM(output_tokens), 0) as output_tokens,
		        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
		        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
		        COALESCE(SUM(total_tokens), 0) as total_tokens,
		        COALESCE(SUM(cost_usd), 0) as cost_usd,
		        COUNT(DISTINCT session_id) as num_sessions
		 FROM token_usage_all WHERE board_name = ? AND `+sourceDedup, boardName)
	if err != nil {
		return nil, err
	}
	return &summary, nil
}

// GetUsageSummary returns totals grouped by agent_type since a given time.
func (s *TokenUsageStore) GetUsageSummary(ctx context.Context, since string) ([]UsageSummary, error) {
	var summaries []UsageSummary
	rel, args := usageCoarseRelation(ctx, s.db.Reader(), since)
	query := `SELECT agent_type,
	          COALESCE(SUM(input_tokens), 0) as input_tokens,
	          COALESCE(SUM(output_tokens), 0) as output_tokens,
	          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
	          COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(total_tokens), 0) as total_tokens,
	          COALESCE(SUM(cost_usd), 0) as cost_usd,
	          COUNT(DISTINCT session_id) as num_sessions,
	          COALESCE(SUM(n_rows), 0) as num_requests
	   FROM ` + rel + ` u WHERE ` + usageDedup("u.")
	query += ` GROUP BY agent_type`
	err := s.db.Reader().SelectContext(ctx, &summaries, query, args...)
	return summaries, err
}

// GetUsageSummaryByModel returns totals grouped by agent type and the model id each row
// recorded. Rows are per API call (hourly rows keep the model too), so a session that switched
// models counts in each model's row with its tokens split between them. Usage with no recorded
// model is one bucket with model "".
func (s *TokenUsageStore) GetUsageSummaryByModel(ctx context.Context, since string) ([]ModelUsageSummary, error) {
	summaries := []ModelUsageSummary{}
	rel, args := usageCoarseRelation(ctx, s.db.Reader(), since)
	query := `SELECT agent_type, COALESCE(model, '') as model,
	          COALESCE(SUM(input_tokens), 0) as input_tokens,
	          COALESCE(SUM(output_tokens), 0) as output_tokens,
	          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
	          COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(total_tokens), 0) as total_tokens,
	          COALESCE(SUM(cost_usd), 0) as cost_usd,
	          COUNT(DISTINCT session_id) as num_sessions,
	          COALESCE(SUM(n_rows), 0) as num_requests
	   FROM ` + rel + ` u WHERE ` + usageDedup("u.")
	query += ` GROUP BY agent_type, COALESCE(model, '') ORDER BY cost_usd DESC, agent_type, model`
	err := s.db.Reader().SelectContext(ctx, &summaries, query, args...)
	return summaries, err
}

// GetUsageSummaryByAgent returns per-agent (session) usage aggregates since a given time.
func (s *TokenUsageStore) GetUsageSummaryByAgent(ctx context.Context, since string) ([]AgentUsageSummary, error) {
	return s.GetUsageSummaryByAgentBoard(ctx, since, "")
}

// GetUsageSummaryByAgentBoard is GetUsageSummaryByAgent for one board (the board a row was recorded on, else the session's own); board "" is every board (#7525).
func (s *TokenUsageStore) GetUsageSummaryByAgentBoard(ctx context.Context, since, board string) ([]AgentUsageSummary, error) {
	return s.GetUsageSummaryByAgentBoardUntil(ctx, since, "", board)
}

// GetUsageSummaryByAgentBoardUntil is GetUsageSummaryByAgentBoard for a window that ends: rows recorded at or after until (in the series' own form, 2006-01-02T15:04:05, which sorts before every
// stamp of that second) are left out; until "" is no end (#8235).
func (s *TokenUsageStore) GetUsageSummaryByAgentBoardUntil(ctx context.Context, since, until, board string) ([]AgentUsageSummary, error) {
	var summaries []AgentUsageSummary
	rel, args := usageRelation(ctx, s.db.Reader(), since, until)
	if until == "" { // no end: the summary does not look at when in its window a row was recorded
		rel, args = usageCoarseRelation(ctx, s.db.Reader(), since)
	}
	// Prefer the session's current display name so renames show, then the name recorded with its usage, then its folder (#10272); only an agent with none of them
	// comes back empty. The folder is also reported separately so same-named rows can be told apart. The time series (usageGroupExpr) names its agents the same way.
	query := `SELECT t.session_id,
	          COALESCE(NULLIF(ls.display_name, ''), NULLIF(MAX(t.agent_name), ''), NULLIF(ls.agent_name, ''), '') as agent_name,
	          t.agent_type, COALESCE(NULLIF(t.board_name, ''), ls.board_name) as board_name,
	          COALESCE(ls.agent_name, '') as folder,
	          COALESCE(ls.working_dir, '') as working_dir,
	          COALESCE(SUM(t.input_tokens), 0) as input_tokens,
	          COALESCE(SUM(t.output_tokens), 0) as output_tokens,
	          COALESCE(SUM(t.cache_read_tokens), 0) as cache_read_tokens,
	          COALESCE(SUM(t.cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(t.total_tokens), 0) as total_tokens,
	          COALESCE(SUM(t.cost_usd), 0) as cost_usd,
	          SUM(t.n_rows) as num_records,
	          MIN(t.min_at) as first_seen,
	          MAX(t.max_at) as last_seen,
	          ls.created_at as launched_at,
	          ls.stopped_at as stopped_at,
	          (ls.session_id IS NOT NULL AND ls.stopped_at IS NULL) as is_live
	   FROM ` + rel + ` t
	   LEFT JOIN live_sessions ls ON ls.session_id = t.session_id
	   WHERE ` + usageDedup("t.")
	if until != "" {
		query += ` AND t.recorded_at < ?`
		args = append(args, until)
	}
	if board != "" {
		query += ` AND COALESCE(NULLIF(t.board_name, ''), ls.board_name) = ?`
		args = append(args, board)
	}
	query += ` GROUP BY t.session_id ORDER BY cost_usd DESC`
	err := s.db.Reader().SelectContext(ctx, &summaries, query, args...)
	return summaries, err
}

// BoardUsageSummary represents aggregated token usage for a board/team.
type BoardUsageSummary struct {
	BoardName        string  `db:"board_name" json:"board_name"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumAgents        int     `db:"num_agents" json:"num_agents"`
}

// BranchUsageSummary represents aggregated token usage for a git branch.
type BranchUsageSummary struct {
	Branch           string  `db:"branch" json:"branch"`
	PRNumber         int     `db:"pr_number" json:"pr_number,omitempty"`
	RemoteURL        string  `db:"remote_url" json:"remote_url,omitempty"`
	RepoName         string  `db:"-" json:"repo_name,omitempty"`
	BoardName        string  `db:"board_name" json:"board_name"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumAgents        int     `db:"num_agents" json:"num_agents"`
}

// GetUsageSummaryByBranch returns per-branch usage aggregates by joining
// token_usage with git_snapshots on session_id. Only sessions that have
// at least one git snapshot are included. Each session is attributed to
// its most recent branch.
func (s *TokenUsageStore) GetUsageSummaryByBranch(ctx context.Context, since string, branch string) ([]BranchUsageSummary, error) {
	rel, args := usageCoarseRelation(ctx, s.db.Reader(), since)
	query := `SELECT gs.branch,
	          COALESCE(MAX(gs.pr_number), 0) as pr_number,
	          COALESCE(MAX(gs.remote_url), '') as remote_url,
	          COALESCE(MAX(t.board_name), '') as board_name,
	          COALESCE(SUM(t.input_tokens), 0) as input_tokens,
	          COALESCE(SUM(t.output_tokens), 0) as output_tokens,
	          COALESCE(SUM(t.cache_read_tokens), 0) as cache_read_tokens,
	          COALESCE(SUM(t.cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(t.total_tokens), 0) as total_tokens,
	          COALESCE(SUM(t.cost_usd), 0) as cost_usd,
	          COUNT(DISTINCT t.session_id) as num_agents
	   FROM ` + rel + ` t
	   INNER JOIN (
	       SELECT session_id, branch, COALESCE(pr_number, 0) as pr_number, COALESCE(remote_url, '') as remote_url
	       FROM git_snapshots
	       WHERE session_id IS NOT NULL
	       AND id IN (
	           SELECT MAX(id) FROM git_snapshots
	           WHERE session_id IS NOT NULL
	           GROUP BY session_id
	       )
	   ) gs ON t.session_id = gs.session_id
	   WHERE ` + usageDedup("t.")
	if branch != "" {
		query += " AND gs.branch = ?"
		args = append(args, branch)
	}
	query += ` GROUP BY gs.branch, gs.remote_url, COALESCE(t.board_name, '') ORDER BY cost_usd DESC`
	var summaries []BranchUsageSummary
	err := s.db.Reader().SelectContext(ctx, &summaries, query, args...)
	return mergeCleanedBranches(summaries), err
}

// mergeCleanedBranches shows each branch cleaned (a name stored before the write path cleaned it, #6832) and merges the rows whose names clean to the same one (same remote and board too): two raw spellings of
// one branch are one row, their tokens and cost added (num_agents added too: it is an upper bound for the merged row), the biggest spender first as before.
func mergeCleanedBranches(in []BranchUsageSummary) []BranchUsageSummary {
	type key struct{ branch, remote, board string }
	index := map[key]int{}
	out := make([]BranchUsageSummary, 0, len(in))
	for _, r := range in {
		r.Branch = clitext.CleanName(r.Branch)
		k := key{r.Branch, r.RemoteURL, r.BoardName}
		i, seen := index[k]
		if !seen {
			index[k] = len(out)
			out = append(out, r)
			continue
		}
		m := &out[i]
		m.InputTokens += r.InputTokens
		m.OutputTokens += r.OutputTokens
		m.CacheReadTokens += r.CacheReadTokens
		m.CacheWriteTokens += r.CacheWriteTokens
		m.TotalTokens += r.TotalTokens
		m.CostUSD += r.CostUSD
		m.NumAgents += r.NumAgents
		m.PRNumber = max(m.PRNumber, r.PRNumber)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CostUSD > out[j].CostUSD })
	return out
}

// GetUsageSummaryByBoard returns per-board (team) usage aggregates since a given time.
func (s *TokenUsageStore) GetUsageSummaryByBoard(ctx context.Context, since string) ([]BoardUsageSummary, error) {
	rel, args := usageCoarseRelation(ctx, s.db.Reader(), since)
	query := `SELECT COALESCE(NULLIF(t.board_name, ''), ls.board_name, '') as board_name,
	          COALESCE(SUM(t.input_tokens), 0) as input_tokens,
	          COALESCE(SUM(t.output_tokens), 0) as output_tokens,
	          COALESCE(SUM(t.cache_read_tokens), 0) as cache_read_tokens,
	          COALESCE(SUM(t.cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(t.total_tokens), 0) as total_tokens,
	          COALESCE(SUM(t.cost_usd), 0) as cost_usd,
	          COUNT(DISTINCT t.session_id) as num_agents
	   FROM ` + rel + ` t LEFT JOIN live_sessions ls ON ls.session_id = t.session_id
	   WHERE ` + usageDedup("t.")
	query += ` GROUP BY COALESCE(NULLIF(t.board_name, ''), ls.board_name, '') ORDER BY cost_usd DESC`
	var summaries []BoardUsageSummary
	err := s.db.Reader().SelectContext(ctx, &summaries, query, args...)
	return summaries, err
}
