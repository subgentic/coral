package store

import (
	"context"
	"database/sql"
	"encoding/json"
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

// UsageAfter is the place a page of ListUsagePage continues from: the last row sent, in the list's order (newest activity first, then session id).
type UsageAfter struct {
	RecordedAt string
	SessionID  string
}

// usageSessionsQuery is one row per session for the filter, newest activity first, then session id: the query the list, its page, its totals and its per-agent rows all share.
// after, when set, keeps only the rows past that place (keyset on MAX(recorded_at), session_id), so a page costs a page and not the whole list (#13218).
func usageSessionsQuery(f UsageFilter, after *UsageAfter) (string, []interface{}) {
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

	query += ` GROUP BY t.session_id`
	if after != nil {
		query += ` HAVING MAX(t.recorded_at) < ? OR (MAX(t.recorded_at) = ? AND t.session_id > ?)`
		args = append(args, after.RecordedAt, after.RecordedAt, after.SessionID)
	}
	query += ` ORDER BY MAX(t.recorded_at) DESC, t.session_id`
	return query, args
}

// ListUsage returns aggregated token usage per session (sum of all per-turn records).
func (s *TokenUsageStore) ListUsage(ctx context.Context, f UsageFilter) ([]TokenUsage, error) {
	query, args := usageSessionsQuery(f, nil)
	var results []TokenUsage
	err := s.db.Reader().SelectContext(ctx, &results, query, args...)
	return results, err
}

// ListUsagePage returns at most limit sessions after the given place (nil: from the newest), in ListUsage's order, cut in SQL.
func (s *TokenUsageStore) ListUsagePage(ctx context.Context, f UsageFilter, after *UsageAfter, limit int) ([]TokenUsage, error) {
	query, args := usageSessionsQuery(f, after)
	query += " LIMIT ?"
	args = append(args, limit)
	var results []TokenUsage
	err := s.db.Reader().SelectContext(ctx, &results, query, args...)
	return results, err
}

// UsageTotals adds up every session the filter matches, in SQL: no row is read into the process.
type UsageTotals struct {
	Sessions         int64   `db:"sessions"`
	InputTokens      int64   `db:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens"`
	TotalTokens      int64   `db:"total_tokens"`
	CostUSD          float64 `db:"cost_usd"`
	FirstStart       string  `db:"first_start"`
	LastActivity     string  `db:"last_activity"`
}

// UsageTotalsFor is the totals of every session the filter matches.
func (s *TokenUsageStore) UsageTotalsFor(ctx context.Context, f UsageFilter) (UsageTotals, error) {
	inner, args := usageSessionsQuery(f, nil)
	var t UsageTotals
	err := s.db.Reader().GetContext(ctx, &t, `SELECT COUNT(*) AS sessions, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
	  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, COALESCE(SUM(total_tokens),0) AS total_tokens,
	  COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(MIN(NULLIF(session_start_at,'')),'') AS first_start, COALESCE(MAX(NULLIF(last_activity_at,'')),'') AS last_activity
	  FROM (`+inner+`)`, args...)
	return t, err
}

// UsageAgent is every matching session of one agent added up (a session's name, else its id).
type UsageAgent struct {
	Name             string  `db:"name" json:"name"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	NumTurns         int64   `db:"num_turns" json:"num_turns"`
}

// UsageByAgent adds the matching sessions up by agent, newest activity first.
func (s *TokenUsageStore) UsageByAgent(ctx context.Context, f UsageFilter) ([]UsageAgent, error) {
	inner, args := usageSessionsQuery(f, nil)
	out := []UsageAgent{}
	err := s.db.Reader().SelectContext(ctx, &out, `SELECT COALESCE(NULLIF(agent_name,''), NULLIF(session_id,''), 'Unknown agent') AS name,
	  COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
	  COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(num_turns),0) AS num_turns
	  FROM (`+inner+`) GROUP BY name ORDER BY MAX(recorded_at) DESC, MIN(session_id)`, args...)
	return out, err
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
	var rows []latestContextRow
	// The read pool (#3461): the live list asks this on every refresh.
	if err := s.db.Reader().SelectContext(ctx, &rows, latestUsageRollup+`
		SELECT session_id, latest_context as context_tokens, MAX(recorded_at) as recorded_at, agent_type, max_id
		FROM counted GROUP BY session_id`, ids); err != nil {
		return nil, err
	}
	s.fixCachedInclusiveContext(ctx, rows)

	resets := s.contextResetsFor(ctx, sessionIDs)
	result := make(map[string]int, len(rows))
	for _, r := range rows {
		if at, ok := resets[r.SessionID]; ok {
			if rec, ok := parseUsageStamp(r.RecordedAt); ok && !rec.After(at) {
				continue // a /compact or /clear came after this turn: its context is not the agent's any more (#15066)
			}
		}
		result[r.SessionID] = r.ContextTokens
	}
	return result, nil
}

// MarkContextReset records that Coral just sent the session a /compact or /clear (#15066): the reading of every turn recorded up to now is dropped from GetLatestTurnContextBySessionIDs until a newer turn arrives.
func (s *TokenUsageStore) MarkContextReset(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO context_resets (session_id, reset_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET reset_at = excluded.reset_at`, sessionID, NowUTC())
	return err
}

// ContextResetsAt is when each of the sessions was last sent a /compact or /clear by Coral, by session id: the compaction's cooldown that outlives a restart.
func (s *TokenUsageStore) ContextResetsAt(ctx context.Context, sessionIDs []string) map[string]time.Time {
	return s.contextResetsFor(ctx, sessionIDs)
}

// contextResetsFor is when each of the sessions was last reset; a read that fails is no reset (the reading shows, as it did before).
func (s *TokenUsageStore) contextResetsFor(ctx context.Context, sessionIDs []string) map[string]time.Time {
	out := map[string]time.Time{}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return out
	}
	var rows []struct {
		SessionID string `db:"session_id"`
		ResetAt   string `db:"reset_at"`
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, `SELECT session_id, reset_at FROM context_resets WHERE session_id IN (SELECT value FROM json_each(?))`, ids); err != nil {
		return out
	}
	for _, r := range rows {
		if t, ok := parseUsageStamp(r.ResetAt); ok {
			out[r.SessionID] = t
		}
	}
	return out
}

// parseUsageStamp reads the stamp forms the usage rows carry ("...Z", with fractions, "+00:00", or a space instead of the T); ok is false for any other.
func parseUsageStamp(v string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
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

// cachedInclusiveTypes are the agent types whose recorded input_tokens already include the cached part (OpenAI's count; proxy.ModelPricing.CachedInputIncluded prices rows that way). The rollup's
// latest_context adds the cache read to the input, which is right for Claude (its input is only the uncached part) and counts a Codex call's cached tokens twice (#15506).
var cachedInclusiveTypes = map[string]bool{"codex": true}

// perCallTypes are the agent types whose rows hold the growth of running totals over several calls (Hermes keeps no record per call, #15508): a row's num_turns is the calls it holds, and the size of one request is its tokens divided by them.
var perCallTypes = map[string]bool{"hermes": true}

// latestContextRow is a session's newest turn as the rollup holds it.
type latestContextRow struct {
	SessionID     string         `db:"session_id"`
	ContextTokens int            `db:"context_tokens"`
	RecordedAt    string         `db:"recorded_at"`
	AgentType     sql.NullString `db:"agent_type"`
	MaxID         sql.NullInt64  `db:"max_id"`
}

// fixCachedInclusiveContext replaces the context of each session of such a type with what its newest call really carried: its input plus any cache write (Codex), or its row's tokens over the calls the row holds (Hermes). It reads those few rows by id, in one query.
func (s *TokenUsageStore) fixCachedInclusiveContext(ctx context.Context, rows []latestContextRow) {
	byID := map[int64]int{}
	var ids []int64
	for i, r := range rows {
		if r.MaxID.Valid && (cachedInclusiveTypes[r.AgentType.String] || perCallTypes[r.AgentType.String]) {
			byID[r.MaxID.Int64] = i
			ids = append(ids, r.MaxID.Int64)
		}
	}
	if len(ids) == 0 {
		return
	}
	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return
	}
	var got []struct {
		ID         int64 `db:"id"`
		Input      int   `db:"input_tokens"`
		CacheRead  int   `db:"cache_read_tokens"`
		CacheWrite int   `db:"cache_write_tokens"`
		NumTurns   int   `db:"num_turns"`
	}
	if err := s.db.Reader().SelectContext(ctx, &got, `SELECT id, input_tokens, cache_read_tokens, cache_write_tokens, num_turns FROM token_usage WHERE id IN (SELECT value FROM json_each(?))`, string(idsJSON)); err != nil {
		return // the sum stays (it overstates; it never hides a context)
	}
	for _, g := range got {
		i, ok := byID[g.ID]
		if !ok {
			continue
		}
		if perCallTypes[rows[i].AgentType.String] {
			rows[i].ContextTokens = (g.Input + g.CacheRead + g.CacheWrite) / max(1, g.NumTurns)
		} else {
			rows[i].ContextTokens = g.Input + g.CacheWrite
		}
	}
}
