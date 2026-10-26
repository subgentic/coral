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
