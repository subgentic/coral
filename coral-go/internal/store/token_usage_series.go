// The token usage series: per-hour and grouped time series for the Cost view, and the per-turn reads (usage turns of a session). Moved out of token_usage.go (#8296), no code changed.

package store

import (
	"context"
	"fmt"
	"strings"
)

// GetSessionTurns returns per-turn cost data for a session, ordered by time.
func (s *TokenUsageStore) GetSessionTurns(ctx context.Context, sessionID string) ([]TurnCost, error) {
	var turns []TurnCost
	err := s.db.Reader().SelectContext(ctx, &turns,
		`SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, COALESCE(model, '') AS model, recorded_at FROM token_usage_all
		 WHERE session_id = ? AND `+sourceDedup+`
		 ORDER BY recorded_at ASC, id ASC`, sessionID)
	return turns, err
}

// UsageTurn is one recorded turn (or, for turns older than the raw rows are kept, one hour of a session's turns of a kind) with whose it was.
type UsageTurn struct {
	SessionID        string  `db:"session_id" json:"session_id"`
	AgentName        string  `db:"agent_name" json:"agent_name"`
	AgentType        string  `db:"agent_type" json:"agent_type"`
	BoardName        string  `db:"board_name" json:"board_name"`
	Model            string  `db:"model" json:"model"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	NumTurns         int     `db:"n_rows" json:"num_turns"`
	RecordedAt       string  `db:"recorded_at" json:"timestamp"`
}

// UsageTurnsQuery picks turns: of one agent (by name) and/or session, recorded from Since (inclusive) to Until (exclusive); Order "cost" (dearest first) or "time" (newest first, the
// default); Limit at most MaxUsageTurns (20 when 0).
type UsageTurnsQuery struct {
	Agent, Session, Since, Until, Order string
	Limit                               int
}

// MaxUsageTurns is the most turns one read returns.
const MaxUsageTurns = 200

// GetUsageTurns lists turns, for the drill-down from a spike to what made it.
func (s *TokenUsageStore) GetUsageTurns(ctx context.Context, q UsageTurnsQuery) ([]UsageTurn, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > MaxUsageTurns {
		limit = MaxUsageTurns
	}
	where, args := []string{sourceDedup}, []interface{}{}
	if q.Agent != "" {
		where, args = append(where, `agent_name = ?`), append(args, q.Agent)
	}
	if q.Session != "" {
		where, args = append(where, `session_id = ?`), append(args, q.Session)
	}
	if q.Since != "" {
		where, args = append(where, `recorded_at >= ?`), append(args, wholeSecondUsageCutoff(q.Since))
	}
	if q.Until != "" {
		where, args = append(where, `recorded_at < ?`), append(args, wholeSecondUsageCutoff(q.Until))
	}
	order := `recorded_at DESC, id DESC`
	if q.Order == "cost" {
		order = `cost_usd DESC, recorded_at DESC, id DESC`
	}
	var turns []UsageTurn
	err := s.db.Reader().SelectContext(ctx, &turns,
		`SELECT session_id, agent_name, agent_type, COALESCE(board_name, '') AS board_name, COALESCE(model, '') AS model, cost_usd, input_tokens, output_tokens,
		        cache_read_tokens, cache_write_tokens, n_rows, recorded_at
		 FROM token_usage_all WHERE `+strings.Join(where, ` AND `)+` ORDER BY `+order+` LIMIT ?`, append(args, limit)...)
	return turns, err
}

// TimeSeriesBucket represents a single time bucket of aggregated cost.
type TimeSeriesBucket struct {
	Bucket           string  `db:"bucket" json:"bucket"`
	CostUSD          float64 `db:"cost_usd" json:"cost_usd"`
	InputTokens      int64   `db:"input_tokens" json:"input_tokens"`
	OutputTokens     int64   `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens  int64   `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens int64   `db:"cache_write_tokens" json:"cache_write_tokens"`
	NumRequests      int     `db:"num_requests" json:"num_requests"`
}

// GetUsageTimeSeries returns cost data bucketed by time interval.
// The interval parameter controls bucket size: "5m", "1h", "1d".
func (s *TokenUsageStore) GetUsageTimeSeries(ctx context.Context, since string, interval string) ([]TimeSeriesBucket, error) {
	return s.GetUsageTimeSeriesBoard(ctx, since, interval, "")
}

// GetUsageTimeSeriesBoard is GetUsageTimeSeries for one board (the board each row was recorded on); board "" is every board (#7525).
func (s *TokenUsageStore) GetUsageTimeSeriesBoard(ctx context.Context, since string, interval string, board string) ([]TimeSeriesBucket, error) {
	grouped, err := s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{Since: since, Interval: interval, Board: board})
	if err != nil {
		return nil, err
	}
	var buckets []TimeSeriesBucket
	for _, g := range grouped {
		buckets = append(buckets, g.TimeSeriesBucket)
	}
	return buckets, nil
}

// TimeSeriesQuery is what a usage time series reads: the rows recorded from Since (inclusive) to Until (exclusive), either may be empty; Interval 5m, 1h or 1d (1h
// otherwise); Board "" for every board; GroupBy "" for the one total series, or team, agent, provider or model for a series each.
type TimeSeriesQuery struct{ Since, Until, Interval, Board, GroupBy string }

// TimeSeriesSeries is one group's usage in one bucket.
type TimeSeriesSeries struct {
	Key              string  `json:"key"`
	Label            string  `json:"label"`
	CostUSD          float64 `json:"cost_usd"`
	InputTokens      int64   `json:"input_tokens"`
	OutputTokens     int64   `json:"output_tokens"`
	CacheReadTokens  int64   `json:"cache_read_tokens"`
	CacheWriteTokens int64   `json:"cache_write_tokens"`
	NumRequests      int     `json:"num_requests"`
}

// GroupedBucket is a bucket's totals and, when the query was grouped, its series (only the groups that had usage in it; the totals are their sum).
type GroupedBucket struct {
	TimeSeriesBucket
	Series []TimeSeriesSeries `json:"series,omitempty"`
}

// UsageGroups are the GroupBy values: the SQL that names a row's group (over usageRelation's columns, alias u), and what an empty value is called.
var usageGroupExpr = map[string]string{
	"team":     `COALESCE(NULLIF(COALESCE(NULLIF(u.board_name, ''), ls.board_name, ''), ''), '(no team)')`, // the board a row names, else its session's (By team's rule)
	"agent":    `COALESCE(NULLIF(u.agent_name, ''), '(unknown)')`,
	"provider": `COALESCE(NULLIF(u.agent_type, ''), 'unknown')`,
	"model":    `COALESCE(NULLIF(u.model, ''), 'unknown')`,
}

// ValidUsageGroup reports whether g is "" or a GroupBy the time series knows.
func ValidUsageGroup(g string) bool { _, ok := usageGroupExpr[g]; return g == "" || ok }

// GetUsageTimeSeriesGrouped is the one usage time series: GetUsageTimeSeries, for a board, over a window, and split by team, agent, provider or model.
func (s *TokenUsageStore) GetUsageTimeSeriesGrouped(ctx context.Context, q TimeSeriesQuery) ([]GroupedBucket, error) {
	var bucketExpr string
	switch q.Interval {
	case "5m":
		bucketExpr = `strftime('%Y-%m-%dT%H:', recorded_at) || printf('%02d', (CAST(strftime('%M', recorded_at) AS INTEGER) / 5) * 5) || ':00Z'`
	case "1d":
		bucketExpr = `strftime('%Y-%m-%dT00:00:00Z', recorded_at)`
	default:
		bucketExpr = `strftime('%Y-%m-%dT%H:00:00Z', recorded_at)`
	}
	groupSQL, groupKey := `''`, ``
	if g, ok := usageGroupExpr[q.GroupBy]; ok {
		groupSQL, groupKey = g, q.GroupBy
	} else if q.GroupBy != "" {
		return nil, fmt.Errorf("unknown group_by %q", q.GroupBy)
	}

	// 5-minute buckets need the rows themselves; the hour and day buckets are made from the hourly aggregate.
	var rel string
	var args []interface{}
	if q.Interval == "5m" {
		rel, args = `(SELECT `+usageCols+`, n_rows, recorded_at FROM token_usage_all`+sinceWhere(q.Since)+`)`, sinceArgs(q.Since)
	} else {
		rel, args = usageRelationWindow(ctx, s.db.Reader(), q.Since, q.Until)
	}
	query := `SELECT ` + bucketExpr + ` AS bucket, ` + groupSQL + ` AS grp,
	          COALESCE(SUM(cost_usd), 0) AS cost_usd,
	          COALESCE(SUM(input_tokens), 0) AS input_tokens,
	          COALESCE(SUM(output_tokens), 0) AS output_tokens,
	          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
	          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
	          SUM(n_rows) AS num_requests
	   FROM ` + rel + ` u LEFT JOIN live_sessions ls ON ls.session_id = u.session_id WHERE ` + usageDedup("u.")
	if q.Board != "" {
		query += ` AND u.board_name = ?`
		args = append(args, q.Board)
	}
	if q.Until != "" {
		query += ` AND u.recorded_at < ?`
		args = append(args, wholeSecondUsageCutoff(q.Until))
	}
	query += ` GROUP BY bucket, grp ORDER BY bucket ASC, grp ASC`

	var rows []struct {
		Group string `db:"grp"`
		TimeSeriesBucket
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	var out []GroupedBucket
	for _, r := range rows {
		if len(out) == 0 || out[len(out)-1].Bucket != r.Bucket {
			out = append(out, GroupedBucket{TimeSeriesBucket: TimeSeriesBucket{Bucket: r.Bucket}})
		}
		b := &out[len(out)-1]
		b.CostUSD += r.CostUSD
		b.InputTokens += r.InputTokens
		b.OutputTokens += r.OutputTokens
		b.CacheReadTokens += r.CacheReadTokens
		b.CacheWriteTokens += r.CacheWriteTokens
		b.NumRequests += r.NumRequests
		if groupKey != "" {
			b.Series = append(b.Series, TimeSeriesSeries{Key: r.Group, Label: r.Group, CostUSD: r.CostUSD, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
				CacheReadTokens: r.CacheReadTokens, CacheWriteTokens: r.CacheWriteTokens, NumRequests: r.NumRequests})
		}
	}
	return out, nil
}
