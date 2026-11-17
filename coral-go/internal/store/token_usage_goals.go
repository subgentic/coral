package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

type GoalUsageWindow struct {
	TaskID                     int64
	Session, Board, Key, Label string
	Claimed, Ended             time.Time
}

// GoalUsageSeries attributes each retained request (or old hourly rollup) once.
// Latest claim wins overlapping windows; a task ID breaks equal-claim ties.
func (s *TokenUsageStore) GoalUsageSeries(ctx context.Context, q TimeSeriesQuery, windows []GoalUsageWindow) ([]GroupedBucket, error) {
	bySession := map[string][]GoalUsageWindow{}
	for _, w := range windows {
		bySession[w.Session] = append(bySession[w.Session], w)
	}
	for session := range bySession {
		sort.Slice(bySession[session], func(i, j int) bool {
			a, b := bySession[session][i], bySession[session][j]
			if a.Claimed.Equal(b.Claimed) {
				return a.TaskID > b.TaskID
			}
			return a.Claimed.After(b.Claimed)
		})
	}
	fields := "session_id,board_name,recorded_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,source"
	union := `(SELECT ` + fields + `,1 AS n_rows,recorded_at AS attribution_at FROM token_usage UNION ALL SELECT ` + fields + `,n_rows,hour || ':00:00Z' AS attribution_at FROM token_usage_hourly)`
	where := ` WHERE ` + sourceDedup
	args := []any{}
	if q.Since != "" {
		where += ` AND recorded_at>=?`
		args = append(args, windowBound(q.Since))
	}
	if q.Until != "" {
		where += ` AND recorded_at<?`
		args = append(args, q.Until)
	}
	if q.Board != "" {
		where += ` AND board_name=?`
		args = append(args, q.Board)
	}
	span := time.Hour
	if q.Interval == "1d" {
		span = 24 * time.Hour
	} else if q.Interval == "5m" {
		span = 5 * time.Minute
	}
	buckets := map[string]map[string]*TimeSeriesSeries{}
	// add puts one row's figures in its bucket and group.
	add := func(stamp time.Time, v TimeSeriesSeries) {
		bucket := stamp.UTC().Truncate(span).Format(time.RFC3339)
		if buckets[bucket] == nil {
			buckets[bucket] = map[string]*TimeSeriesSeries{}
		}
		g := buckets[bucket][v.Key]
		if g == nil {
			g = &TimeSeriesSeries{Key: v.Key, Label: v.Label}
			buckets[bucket][v.Key] = g
		}
		g.CostUSD += v.CostUSD
		g.InputTokens += v.InputTokens
		g.OutputTokens += v.OutputTokens
		g.CacheReadTokens += v.CacheReadTokens
		g.CacheWriteTokens += v.CacheWriteTokens
		g.NumRequests += v.NumRequests
		for _, id := range v.TaskIDs {
			found := false
			for _, old := range g.TaskIDs {
				if old == id {
					found = true
					break
				}
			}
			if !found {
				g.TaskIDs = append(g.TaskIDs, id)
			}
		}
	}
	// Only a session that has a work window can be attributed to a goal: every other row is "Not on a task" whatever its time, so those are summed by the database per minute
	// (a few rows, not one per request) and the per-row scan of windows runs for the sessions that have them only (#19246).
	sessionList := make([]string, 0, len(bySession))
	for session := range bySession {
		sessionList = append(sessionList, session)
	}
	sort.Strings(sessionList)
	listJSON, err := json.Marshal(sessionList)
	if err != nil {
		return nil, err
	}
	listArgs := append(append([]any{}, args...), string(listJSON))
	plain, err := s.db.Reader().QueryContext(ctx, `SELECT substr(recorded_at,1,16),SUM(cost_usd),SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens),SUM(cache_write_tokens),SUM(n_rows) FROM `+union+where+` AND session_id NOT IN (SELECT value FROM json_each(?)) GROUP BY 1`, listArgs...)
	if err != nil {
		return nil, err
	}
	defer plain.Close()
	for plain.Next() {
		var minute string
		var v TimeSeriesSeries
		if err := plain.Scan(&minute, &v.CostUSD, &v.InputTokens, &v.OutputTokens, &v.CacheReadTokens, &v.CacheWriteTokens, &v.NumRequests); err != nil {
			return nil, err
		}
		stamp, err := time.Parse(time.RFC3339, minute+":00Z")
		if err != nil {
			return nil, err
		}
		v.Key, v.Label = "untasked", "Not on a task"
		add(stamp, v)
	}
	if err := plain.Err(); err != nil {
		return nil, err
	}
	query := `SELECT session_id,COALESCE(board_name,''),recorded_at,attribution_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,n_rows FROM ` + union + where + ` AND session_id IN (SELECT value FROM json_each(?))`
	rows, err := s.db.Reader().QueryContext(ctx, query, listArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var session, board, at, attributedAt string
		var v TimeSeriesSeries
		if err := rows.Scan(&session, &board, &at, &attributedAt, &v.CostUSD, &v.InputTokens, &v.OutputTokens, &v.CacheReadTokens, &v.CacheWriteTokens, &v.NumRequests); err != nil {
			return nil, err
		}
		stamp, err := time.Parse(time.RFC3339Nano, at)
		if err != nil {
			return nil, err
		}
		attributed, err := time.Parse(time.RFC3339Nano, attributedAt)
		if err != nil {
			return nil, err
		}
		v.Key, v.Label = "untasked", "Not on a task"
		for _, w := range bySession[session] {
			if (board == "" || board == w.Board) && !attributed.Before(w.Claimed) && (w.Ended.IsZero() || attributed.Before(w.Ended)) {
				v.Key, v.Label = w.Key, w.Label
				v.TaskIDs = []int64{w.TaskID}
				break
			}
		}
		add(stamp, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []GroupedBucket{}
	for stamp, groups := range buckets {
		b := GroupedBucket{TimeSeriesBucket: TimeSeriesBucket{Bucket: stamp}}
		for _, g := range groups {
			b.Series = append(b.Series, *g)
			b.CostUSD += g.CostUSD
			b.InputTokens += g.InputTokens
			b.OutputTokens += g.OutputTokens
			b.CacheReadTokens += g.CacheReadTokens
			b.CacheWriteTokens += g.CacheWriteTokens
			b.NumRequests += g.NumRequests
		}
		sort.Slice(b.Series, func(i, j int) bool { return b.Series[i].Key < b.Series[j].Key })
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bucket < out[j].Bucket })
	return out, nil
}
