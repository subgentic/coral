package routes

import (
	"context"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

func TestUsageWholeSecondSinceIncludesTheCutoff8624(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	cutoff := time.Date(2026, 10, 26, 10, 30, 0, 0, time.UTC)
	for i, row := range []struct {
		at   string
		cost float64
	}{
		{cutoff.Add(-time.Millisecond).Format("2006-01-02T15:04:05.000Z"), 4},
		{cutoff.Format("2006-01-02T15:04:05.000Z"), 1},
		{cutoff.Format(store.ISOFormat), 2},
		{cutoff.Add(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), 8},
	} {
		require.NoError(t, ts.RecordUsage(context.Background(), &store.TokenUsage{SessionID: fmt.Sprintf("cutoff-%d", i), AgentName: "cutoff", AgentType: "claude", Source: "jsonl", RecordedAt: row.at, CostUSD: row.cost, InputTokens: 1, TotalTokens: 1}))
	}
	for _, since := range []string{cutoff.Format(time.RFC3339), cutoff.Format("2006-01-02T15:04:05.000Z"), cutoff.Format(store.ISOFormat), "2026-10-26T10:30:00+00:00"} {
		t.Run(since, func(t *testing.T) {
			q := "?since=" + url.QueryEscape(since)
			for _, endpoint := range []string{"/api/token-usage", "/api/token-usage/summary"} {
				var got struct {
					Totals struct {
						Cost float64 `json:"cost_usd"`
					} `json:"totals"`
				}
				require.Equal(t, 200, seriesGet(t, r, endpoint+q, false, &got))
				assert.Equal(t, 11.0, got.Totals.Cost, endpoint+": inclusive cutoff retains every fractional layout of that second and excludes the prior millisecond")
			}
			for _, interval := range []string{"5m", "1h", "1d"} {
				var got struct {
					Buckets []struct {
						Cost float64 `json:"cost_usd"`
					} `json:"buckets"`
				}
				require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries"+q+"&interval="+interval, false, &got))
				var sum float64
				for _, b := range got.Buckets {
					sum += b.Cost
				}
				assert.Equal(t, 11.0, sum, interval)
			}
			var got struct {
				Turns []struct {
					Cost float64 `json:"cost_usd"`
				} `json:"turns"`
			}
			require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/turns"+q, false, &got))
			var sum float64
			for _, v := range got.Turns {
				sum += v.Cost
			}
			assert.Equal(t, 11.0, sum, "turns")
		})
	}
}

func TestUsageCachedHoursRespectUntil8624(t *testing.T) {
	ts, r, db := seriesRouter(t)
	base := time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC)
	for i, row := range []struct {
		minutes int
		cost    float64
	}{{70, 8}, {130, 1}, {150, 4}, {160, 2}, {190, 16}} {
		at := base.Add(time.Duration(row.minutes) * time.Minute).Format("2006-01-02T15:04:05.000Z")
		if row.minutes == 150 {
			at = base.Add(150 * time.Minute).Format(store.ISOFormat)
		}
		require.NoError(t, ts.RecordUsage(t.Context(), &store.TokenUsage{SessionID: fmt.Sprintf("window-%d", i), AgentName: "window", AgentType: "claude", Model: "test", Source: "jsonl", RecordedAt: at, CostUSD: row.cost, InputTokens: int(row.cost), TotalTokens: int(row.cost)}))
	}
	n, err := db.RefreshTokenUsageHourAgg(t.Context(), base.Add(5*time.Hour), 100)
	require.NoError(t, err)
	require.Equal(t, 3, n, "the test must exercise populated cached hours")
	for _, interval := range []string{"5m", "1h", "1d"} {
		for _, group := range []string{"", "model"} {
			t.Run(interval+"/"+group, func(t *testing.T) {
				read := func(since, until time.Time) (float64, int, int) {
					t.Helper()
					q := url.Values{"since": {since.Format(time.RFC3339)}, "until": {until.Format(time.RFC3339)}, "interval": {interval}, "group_by": {group}}
					var got struct {
						Buckets []struct {
							Cost     float64 `json:"cost_usd"`
							Input    int     `json:"input_tokens"`
							Requests int     `json:"num_requests"`
						} `json:"buckets"`
					}
					require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?"+q.Encode(), false, &got))
					var cost float64
					var tokens, requests int
					for _, b := range got.Buckets {
						cost += b.Cost
						tokens += b.Input
						requests += b.Requests
					}
					// Turns read the raw rows: the same exclusive bound must
					// exclude the six-decimal spelling of the cutoff there too.
					var turns struct {
						Turns []struct {
							Cost float64 `json:"cost_usd"`
						} `json:"turns"`
					}
					require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/turns?"+q.Encode(), false, &turns))
					var turnCost float64
					for _, row := range turns.Turns {
						turnCost += row.Cost
					}
					assert.Equal(t, cost, turnCost, "series and raw turns must agree on the window")
					return cost, tokens, requests
				}
				end := base.Add(4 * time.Hour)
				all, at, ar := read(base, end)
				require.Equal(t, 31.0, all)
				require.Equal(t, 31, at)
				require.Equal(t, 5, ar)
				for _, split := range []struct {
					minutes  int
					cost     float64
					requests int
				}{{150, 9, 2}, {120, 8, 1}, {90, 8, 1}} {
					cut := base.Add(time.Duration(split.minutes) * time.Minute)
					before, bt, br := read(base, cut)
					after, apt, apr := read(cut, end)
					assert.Equal(t, split.cost, before, "before %s", cut)
					assert.Equal(t, int(split.cost), bt)
					assert.Equal(t, split.requests, br)
					assert.Equal(t, all, before+after, "adjacent windows must partition costs at %s", cut)
					assert.Equal(t, at, bt+apt, "adjacent windows must partition tokens")
					assert.Equal(t, ar, br+apr, "adjacent windows must partition requests")
				}
			})
		}
	}
}
