package routes

// The Hub's Analytics overview (coral-hub, #9838): its tiles are the sum of the team-series buckets of the range the page asks for, so they must equal summary.totals, and the provider and
// model series must equal by_agent_type and by_model. This drives Coral's own handlers (summary and timeseries) over a real store with rows that straddle the range's `since` edge and the
// bucket edges, with and without the rows rolled up into token_usage_hourly, at the page's four ranges (1h, 24h, 7d, 30d).

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

func TestTheSeriesBucketsSumToTheSummaryTotalsAtTheEdges(t *testing.T) {
	type rng struct {
		name     string
		d        time.Duration
		interval string
	}
	ranges := []rng{{"1h", time.Hour, "5m"}, {"24h", 24 * time.Hour, "1h"}, {"7d", 7 * 24 * time.Hour, "1d"}, {"30d", 30 * 24 * time.Hour, "1d"}}
	for _, rolled := range []bool{false, true} {
		for _, rg := range ranges {
			t.Run(fmt.Sprintf("%s rolled=%v", rg.name, rolled), func(t *testing.T) {
				ts, r, db := seriesRouter(t)
				now := time.Now().UTC().Truncate(time.Second)
				step := map[string]time.Duration{"5m": 5 * time.Minute, "1h": time.Hour, "1d": 24 * time.Hour}[rg.interval]
				// the page's since: now - range, on the 5-minute grid for 1h and the UTC hour for the rest
				grid := time.Hour
				if rg.name == "1h" {
					grid = 5 * time.Minute
				}
				since := now.Add(-rg.d).Truncate(grid)
				board := func(s string) *string { return &s }
				ms := "2006-01-02T15:04:05.000Z"
				nextEdge := since.Truncate(step).Add(step) // the first bucket edge after since (midnight for daily)
				at := []time.Time{
					since.Add(-time.Hour), since.Add(-time.Millisecond), since, since.Add(time.Millisecond), since.Add(grid / 2),
					nextEdge.Add(-time.Millisecond), nextEdge, nextEdge.Add(time.Millisecond), now.Add(-time.Minute),
				}
				for i, a := range at {
					team, agent := "team-a", "claude"
					if i%2 == 1 {
						team, agent = "team-b", "codex"
					}
					u := store.TokenUsage{SessionID: fmt.Sprintf("s%d", i%3), AgentName: fmt.Sprintf("n%d", i%3), AgentType: agent, BoardName: board(team), Model: map[bool]string{true: "m1", false: "m2"}[i%2 == 0], Source: "jsonl",
						InputTokens: 100 + i, OutputTokens: 10 + i, CacheReadTokens: 1000 + i, CacheWriteTokens: 5 + i, TotalTokens: 1115 + 4*i, CostUSD: 0.25 + float64(i)/8, RecordedAt: a.Format(ms)}
					require.NoError(t, ts.RecordUsage(t.Context(), &u), i)
				}
				if rolled {
					// every completed hour is hourly rows (the since edge and the middle of the range included)
					h, n, err := db.RollupTokenUsage(t.Context(), now, 100000)
					require.NoError(t, err)
					require.Greater(t, n, int64(0), "rows were rolled into hourly rows")
					t.Logf("rolled %d hours, %d raw rows", h, n)
				}
				q := "?since=" + url.QueryEscape(since.Format(ms))
				var sum map[string]any
				require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/summary"+q, false, &sum))
				totals := sum["totals"].(map[string]any)
				var series struct {
					Buckets []map[string]any `json:"buckets"`
				}
				require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries"+q+"&interval="+rg.interval+"&group_by=team", false, &series))
				require.NotEmpty(t, series.Buckets)
				for _, k := range []string{"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "num_requests"} {
					var s float64
					for _, b := range series.Buckets {
						s += b[k].(float64)
					}
					assert.Equal(t, totals[k].(float64), s, k)
				}
				var c float64
				for _, b := range series.Buckets {
					c += b["cost_usd"].(float64)
				}
				assert.InDelta(t, totals["cost_usd"].(float64), c, 1e-9, "cost_usd")
				assert.Greater(t, totals["num_requests"].(float64), 0.0)
				// the provider and model tables: the series summed over the range, per key, against the summary's rows (by_model's rows are per provider and model: summed per model)
				for _, g := range []struct{ group, rows, field string }{{"provider", "by_agent_type", "agent_type"}, {"model", "by_model", "model"}} {
					var gs struct {
						Buckets []struct {
							Series []map[string]any `json:"series"`
						} `json:"buckets"`
					}
					require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries"+q+"&interval="+rg.interval+"&group_by="+g.group, false, &gs))
					got := map[string]map[string]float64{}
					for _, b := range gs.Buckets {
						for _, x := range b.Series {
							k := x["key"].(string)
							if got[k] == nil {
								got[k] = map[string]float64{}
							}
							for _, f := range []string{"cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "num_requests"} {
								got[k][f] += x[f].(float64)
							}
						}
					}
					want := map[string]map[string]float64{}
					for _, row := range sum[g.rows].([]any) {
						m := row.(map[string]any)
						k, _ := m[g.field].(string)
						if k == "" {
							k = map[string]string{"provider": "unknown", "model": "unknown"}[g.group]
						}
						if want[k] == nil {
							want[k] = map[string]float64{}
						}
						for _, f := range []string{"cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "num_requests"} {
							v, _ := m[f].(float64)
							want[k][f] += v
						}
					}
					require.Equal(t, len(want), len(got), g.group+" keys")
					for k, w := range want {
						for f, v := range w {
							assert.InDelta(t, v, got[k][f], 1e-9, "%s %s %s", g.group, k, f)
						}
					}
				}
			})
		}
	}
}
