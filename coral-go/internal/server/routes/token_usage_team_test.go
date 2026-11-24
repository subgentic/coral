package routes

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #21037: the Cost page's Team select. summary, by-branch and timeseries take team=<board>: the usage a team's rows (or, with none named, its sessions') carry, so the teams' figures add up to the
// unfiltered ones; a team that no row names gives empty answers, never every team.
func TestUsageSummaryAndSeriesFollowTheTeam(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	at := time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04:05.000Z")
	rec := func(id, board string, cost float64, in int, model string) {
		b := board
		u := store.TokenUsage{SessionID: id, AgentName: id, AgentType: "claude", Model: model, InputTokens: in, OutputTokens: 1, CostUSD: cost, RecordedAt: at, Source: "jsonl"}
		if board != "" {
			u.BoardName = &b
		}
		u.TotalTokens = u.InputTokens + u.OutputTokens
		require.NoError(t, ts.RecordUsage(t.Context(), &u))
	}
	rec("a1", "alpha", 0.5, 100, "opus")
	rec("a2", "alpha", 0.25, 50, "sonnet")
	rec("b1", "beta", 1.0, 400, "opus")
	rec("n1", "", 0.125, 10, "opus") // on no team

	type sum struct {
		Totals   map[string]any   `json:"totals"`
		ByModel  []map[string]any `json:"by_model"`
		ByAgent  []map[string]any `json:"by_agent"`
		Thinking []map[string]any `json:"by_thinking"`
	}
	get := func(team string) sum {
		var s sum
		q := ""
		if team != "" {
			q = "?team=" + team
		}
		require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/summary"+q, false, &s))
		return s
	}
	cost := func(s sum) float64 { return s.Totals["cost_usd"].(float64) }
	all, alpha, beta, none := get(""), get("alpha"), get("beta"), get("nosuchteam")
	assert.InDelta(t, 1.875, cost(all), 1e-9)
	assert.InDelta(t, 0.75, cost(alpha), 1e-9)
	assert.InDelta(t, 1.0, cost(beta), 1e-9)
	assert.InDelta(t, 0.0, cost(none), 1e-9, "a team that names no board is empty, not everything")
	assert.Empty(t, none.ByAgent)
	assert.Empty(t, none.ByModel)
	assert.Len(t, alpha.ByAgent, 2, "the agents of the team only")
	assert.Len(t, alpha.ByModel, 2, "the models of the team only")
	assert.InDelta(t, cost(all), cost(alpha)+cost(beta)+0.125, 1e-9, "the teams and the usage on none add up to the whole")
	for _, row := range alpha.Thinking {
		assert.Equal(t, "", fmt.Sprint(row["thinking"]), "a team's usage is not split by another's thinking levels: all of it is not reported")
	}

	// the time series
	type ser struct {
		Buckets []map[string]any `json:"buckets"`
		Totals  map[string]any   `json:"totals"`
	}
	sumSeries := func(team string) float64 {
		var s ser
		q := "?interval=1d"
		if team != "" {
			q += "&team=" + team
		}
		require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries"+q, false, &s))
		var c float64
		for _, b := range s.Buckets {
			c += b["cost_usd"].(float64)
		}
		return c
	}
	assert.InDelta(t, 1.875, sumSeries(""), 1e-9)
	assert.InDelta(t, 0.75, sumSeries("alpha"), 1e-9)
	assert.InDelta(t, 0.0, sumSeries("nosuchteam"), 1e-9)
}
