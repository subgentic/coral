package store

import (
	"context"
	"time"
)

// TokenUsage represents a token usage snapshot for a session.
type TokenUsage struct {
	ID               int64   `db:"id" json:"id"`
	SessionID        string  `db:"session_id" json:"session_id"`
	AgentName        string  `db:"agent_name" json:"agent_name"`
	AgentType        string  `db:"agent_type" json:"agent_type"`
	TeamID           *int64  `db:"team_id" json:"team_id,omitempty"`
	BoardName        *string `db:"board_name" json:"board_name,omitempty"`
	InputTokens      int     `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int     `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int     `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int     `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int     `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumTurns         int     `db:"num_turns" json:"num_turns"`
	SessionStartAt   string  `db:"session_start_at" json:"session_start_at,omitempty"`
	LastActivityAt   string  `db:"last_activity_at" json:"last_activity_at,omitempty"`
	ExecutionTimeSec int64   `db:"execution_time_sec" json:"execution_time_sec"`
	RecordedAt       string  `db:"recorded_at" json:"recorded_at"`
	Source           string  `db:"source" json:"source,omitempty"`
	// Model is the model the agent reported for these tokens. Set it only to a
	// value that was actually observed: leave it empty (stored as NULL) rather
	// than filling in a default, so the column never holds a guess. It is
	// write-only for now: the session-level reads aggregate rows that may span
	// several models, so they do not select it.
	Model string `db:"model" json:"model,omitempty"`
	// Thinking is the thinking level the call's turn ran at, as the transcript recorded it ("" when it recorded none: never a guess).
	// ThinkingTokens is the thinking tokens the CLI reported for the call. Both only feed the Cost view's breakdown by thinking level
	// (token_usage_thinking); they are not columns of the usage rows (#4969).
	Thinking       string `db:"-" json:"-"`
	ThinkingTokens int    `db:"-" json:"-"`
}

// UsageSummary represents aggregated token usage totals.
type UsageSummary struct {
	AgentType        string  `db:"agent_type" json:"agent_type"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumSessions      int     `db:"num_sessions" json:"num_sessions"`
	NumRequests      int64   `db:"num_requests" json:"num_requests"` // the calls recorded (what By agent sums as Requests); num_sessions is the distinct sessions
}

// ModelUsageSummary is token usage for one model id of one agent type. Model is "" for usage
// that recorded no model (older rows, or a CLI that does not report one): that bucket is shown
// as unknown, never filled with a guess.
type ModelUsageSummary struct {
	AgentType        string  `db:"agent_type" json:"agent_type"`
	Model            string  `db:"model" json:"model"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumSessions      int     `db:"num_sessions" json:"num_sessions"`
	NumRequests      int64   `db:"num_requests" json:"num_requests"` // the calls recorded (what By agent sums as Requests); num_sessions is the distinct sessions
}

// AgentUsageSummary represents per-agent (session) token usage aggregates.
type AgentUsageSummary struct {
	SessionID        string  `db:"session_id" json:"session_id"`
	AgentName        string  `db:"agent_name" json:"agent_name"`
	AgentType        string  `db:"agent_type" json:"agent_type"`
	BoardName        *string `db:"board_name" json:"board_name,omitempty"`
	Folder           string  `db:"folder" json:"folder"`
	WorkingDir       string  `db:"working_dir" json:"working_dir"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens" json:"total_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumRecords       int     `db:"num_records" json:"requests"`
	FirstSeen        string  `db:"first_seen" json:"first_seen"`
	LastSeen         string  `db:"last_seen" json:"last_seen"`
	LaunchedAt       *string `db:"launched_at" json:"launched_at,omitempty"`
	StoppedAt        *string `db:"stopped_at" json:"stopped_at,omitempty"`
	// IsLive: the session is running now (it has a live_sessions row that has not stopped); false for one that ended or was never launched here. The Cost page says "(ended)" for a row that is false.
	IsLive bool `db:"is_live" json:"is_live"`
}

// sourceDedup is a SQL filter that prefers JSONL records over proxy records
// for the same session. When both sources exist, only JSONL is counted to
// avoid double-counting tokens.
const sourceDedup = `(COALESCE(source,'jsonl') = 'jsonl' OR session_id NOT IN (SELECT DISTINCT session_id FROM token_usage_all WHERE source = 'jsonl'))`

// usageDedup is sourceDedup over usageRelation's rows (source is already COALESCEd there), with the sessions that have a jsonl row read from
// token_usage_rollup (one row per session and source) rather than from a scan of every usage row. alias is "" or "t.".
func usageDedup(alias string) string {
	return `(` + alias + `source = 'jsonl' OR ` + alias + `session_id NOT IN (SELECT session_id FROM token_usage_rollup WHERE source = 'jsonl'))`
}

// TurnCost represents a single turn's cost data for charting.
type TurnCost struct {
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	Model            string  `db:"model" json:"model"`
	RecordedAt       string  `db:"recorded_at" json:"timestamp"`
}

// UsageFilter specifies filters for ListUsage.
type UsageFilter struct {
	SessionID string
	TeamID    *int64
	BoardName string
	Since     string
}

// TokenUsageStore provides CRUD and aggregation for token usage records.
type TokenUsageStore struct {
	db *DB
}

// NewTokenUsageStore creates a new TokenUsageStore.
func NewTokenUsageStore(db *DB) *TokenUsageStore {
	return &TokenUsageStore{db: db}
}

// ListUsage returns aggregated token usage per session (sum of all per-turn records).
func (s *TokenUsageStore) ListUsage(ctx context.Context, f UsageFilter) ([]TokenUsage, error) {
	query := `SELECT MAX(t.id) as id, t.session_id,
	          COALESCE(NULLIF(MAX(ls.display_name), ''), MAX(t.agent_name)) as agent_name,
	          MAX(t.agent_type) as agent_type,
	          MAX(t.team_id) as team_id, COALESCE(NULLIF(MAX(t.board_name), ''), MAX(ls.board_name)) as board_name,
	          COALESCE(SUM(t.input_tokens), 0) as input_tokens, COALESCE(SUM(t.output_tokens), 0) as output_tokens,
	          COALESCE(SUM(t.cache_read_tokens), 0) as cache_read_tokens, COALESCE(SUM(t.cache_write_tokens), 0) as cache_write_tokens,
	          COALESCE(SUM(t.total_tokens), 0) as total_tokens, COALESCE(SUM(t.cost_usd), 0) as cost_usd,
	          SUM(t.n_rows) as num_turns,
	          COALESCE(MIN(NULLIF(t.session_start_at, '')), '') as session_start_at,
	          COALESCE(MAX(NULLIF(t.last_activity_at, '')), '') as last_activity_at,
	          CASE WHEN MIN(NULLIF(t.session_start_at, '')) IS NOT NULL AND MAX(NULLIF(t.last_activity_at, '')) IS NOT NULL
	               THEN MAX(0, CAST(ROUND((julianday(MAX(NULLIF(t.last_activity_at, ''))) - julianday(MIN(NULLIF(t.session_start_at, '')))) * 86400) AS INTEGER))
	               ELSE 0 END as execution_time_sec,
	          MAX(t.recorded_at) as recorded_at,
	          COALESCE(MAX(t.source), 'jsonl') as source
	   FROM token_usage_all t LEFT JOIN live_sessions ls ON ls.session_id = t.session_id WHERE (COALESCE(t.source,'jsonl') = 'jsonl' OR t.session_id NOT IN (SELECT DISTINCT session_id FROM token_usage_all WHERE source = 'jsonl')) AND 1=1`
	var args []interface{}

	if f.SessionID != "" {
		query += " AND t.session_id = ?"
		args = append(args, f.SessionID)
	}
	if f.TeamID != nil {
		query += " AND t.team_id = ?"
		args = append(args, *f.TeamID)
	}
	if f.BoardName != "" {
		query += " AND COALESCE(NULLIF(t.board_name, ''), ls.board_name) = ?"
		args = append(args, f.BoardName)
	}
	if f.Since != "" {
		query += " AND t.recorded_at >= ?"
		args = append(args, windowBound(f.Since))
	}

	query += ` GROUP BY t.session_id ORDER BY MAX(t.recorded_at) DESC, t.session_id`

	var results []TokenUsage
	err := s.db.Reader().SelectContext(ctx, &results, query, args...)
	return results, err
}

// latestUsageRollup selects the rollup rows that count for each requested
// session under the sourceDedup rule: its jsonl row if it has one, otherwise
// all of its rows. Reading the rollup instead of token_usage keeps the
// per-tick cost independent of how many turns a session has had.
const latestUsageRollup = `WITH r AS (
	SELECT * FROM token_usage_rollup WHERE session_id IN (SELECT value FROM json_each(?))
), counted AS (
	SELECT * FROM r WHERE source = 'jsonl'
	   OR NOT EXISTS (SELECT 1 FROM r j WHERE j.session_id = r.session_id AND j.source = 'jsonl')
)`

// GetLatestUsageBySessionIDs returns the latest token usage record per session
// for the given session IDs, keyed by session_id.
func (s *TokenUsageStore) GetLatestUsageBySessionIDs(ctx context.Context, sessionIDs []string) (map[string]*TokenUsage, error) {
	if len(sessionIDs) == 0 {
		return map[string]*TokenUsage{}, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	var records []TokenUsage
	// The read pool (#3461): the live list asks this on every refresh.
	if err := s.db.Reader().SelectContext(ctx, &records, latestUsageRollup+`
		SELECT MAX(max_id) as id, session_id, MAX(agent_name) as agent_name, MAX(agent_type) as agent_type,
		 MAX(team_id) as team_id, MAX(board_name) as board_name,
		 SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
		 SUM(cache_read_tokens) as cache_read_tokens, SUM(cache_write_tokens) as cache_write_tokens,
		 SUM(total_tokens) as total_tokens, SUM(cost_usd) as cost_usd,
		 SUM(num_turns) as num_turns, MAX(recorded_at) as recorded_at
		FROM counted GROUP BY session_id`, ids); err != nil {
		return nil, err
	}

	result := make(map[string]*TokenUsage, len(records))
	for i := range records {
		result[records[i].SessionID] = &records[i]
	}
	return result, nil
}

// GetLatestTurnContextBySessionIDs returns the latest single turn's total context
// usage per session (input_tokens + cache_read_tokens + cache_write_tokens).
// This represents the current context window fill level since each API call
// sends the full conversation as input (split across fresh, cached, and new-cache tokens).
func (s *TokenUsageStore) GetLatestTurnContextBySessionIDs(ctx context.Context, sessionIDs []string) (map[string]int, error) {
	if len(sessionIDs) == 0 {
		return map[string]int{}, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	// With a single MAX() aggregate, SQLite takes the bare latest_context
	// from the row holding the newest turn.
	var rows []struct {
		SessionID     string `db:"session_id"`
		ContextTokens int    `db:"context_tokens"`
		RecordedAt    string `db:"recorded_at"`
	}
	// The read pool (#3461): the live list asks this on every refresh.
	if err := s.db.Reader().SelectContext(ctx, &rows, latestUsageRollup+`
		SELECT session_id, latest_context as context_tokens, MAX(recorded_at) as recorded_at
		FROM counted GROUP BY session_id`, ids); err != nil {
		return nil, err
	}

	result := make(map[string]int, len(rows))
	for _, r := range rows {
		result[r.SessionID] = r.ContextTokens
	}
	return result, nil
}

// tokenUsageNow stamps a usage report that has no timestamp of its own (a var for tests).
var tokenUsageNow = NowUTC

// windowBound is a window's start or end as the stored stamps compare against it. The stamps are text in several forms ("...:00Z", "...:00.000Z", "...:00.000000+00:00", bare "...:00"), and
// as text "." sorts before "Z": a since of "2026-10-25T10:00:00Z" was greater than the row stamped "2026-10-25T10:00:00.000Z" that is exactly at it, and that row was dropped (#8634). A whole-second
// time is therefore made the series' own form, 2006-01-02T15:04:05 in UTC, which sorts before every stamp of that second. Exact-millisecond fractions use three digits without a suffix:
// ".5Z" sorts after ".500Z", but the prefix ".500" includes both ".500Z" and ".500000+00:00" at the cutoff (#8660). Finer precision and invalid times are left unchanged, never rounded.
func windowBound(t string) string {
	parsed, err := time.Parse(time.RFC3339Nano, t)
	if err != nil {
		parsed, err = time.Parse("2006-01-02 15:04:05", t) // a space for the T sorts before every stamp of that day
	}
	if err != nil {
		return t
	}
	if parsed.Nanosecond() == 0 {
		return parsed.UTC().Format("2006-01-02T15:04:05")
	}
	if parsed.Nanosecond()%int(time.Millisecond) == 0 {
		return parsed.UTC().Format("2006-01-02T15:04:05.000")
	}
	return t
}

func sinceWhere(since string) string {
	if since == "" {
		return ""
	}
	return " WHERE recorded_at >= ?"
}

func sinceArgs(since string) []interface{} {
	if since == "" {
		return nil
	}
	return []interface{}{windowBound(since)}
}
