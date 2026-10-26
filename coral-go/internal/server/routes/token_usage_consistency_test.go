package routes

import (
	"fmt"
	"math"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// The Analytics page says one number in many places: the tiles, each breakdown table, the cumulative line and its series. This seeds usage with known answers (two
// providers, three models, four agents, three teams and a row of no team, usage older than a day, a proxy row of a session that also has transcript rows, a row
// whose team is only its session's) and checks, for each range, that every view adds up to the same totals. A failure here is a number on the page that disagrees with another.

type figures struct{ cost, in, out, cr, cw float64 }

func (f figures) plus(g figures) figures {
	return figures{f.cost + g.cost, f.in + g.in, f.out + g.out, f.cr + g.cr, f.cw + g.cw}
}

func (f figures) equal(t *testing.T, g figures, msg string, args ...any) {
	t.Helper()
	m := fmt.Sprintf(msg, args...)
	assert.InDelta(t, f.cost, g.cost, 1e-6, m+": cost")
	assert.Equal(t, []float64{f.in, f.out, f.cr, f.cw}, []float64{g.in, g.out, g.cr, g.cw}, m+": tokens")
}

func figs(m map[string]any) figures {
	n := func(k string) float64 { v, _ := m[k].(float64); return v }
	return figures{n("cost_usd"), n("input_tokens"), n("output_tokens"), n("cache_read_tokens"), n("cache_write_tokens")}
}

func sumRows(rows []any) (f figures) {
	for _, r := range rows {
		f = f.plus(figs(r.(map[string]any)))
	}
	return
}

func seedConsistency(t *testing.T, db *store.DB, ts *store.TokenUsageStore, now time.Time) {
	t.Helper()
	at := func(h float64) string {
		return now.Add(-time.Duration(h * float64(time.Hour))).Format("2006-01-02T15:04:05.000Z")
	}
	board := func(s string) *string { return &s }
	_, err := db.Exec(`INSERT INTO live_sessions(session_id, agent_type, agent_name, display_name, board_name, working_dir, created_at) VALUES('s5', 'codex', 'eps', 'Eps', 'team-c', '/tmp', ?)`, at(100))
	require.NoError(t, err)
	rows := []store.TokenUsage{
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: board("team-a"), Model: "claude-opus-5-5", Source: "jsonl", InputTokens: 1000, OutputTokens: 100, CacheReadTokens: 9000, CacheWriteTokens: 500, CostUSD: 0.31, RecordedAt: at(1.2)},
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: board("team-a"), Model: "claude-opus-5-5", Source: "jsonl", InputTokens: 2000, OutputTokens: 300, CacheReadTokens: 4000, CacheWriteTokens: 0, CostUSD: 0.52, RecordedAt: at(3.5)},
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: board("team-a"), Model: "claude-sonnet-5-5", Source: "jsonl", InputTokens: 700, OutputTokens: 70, CostUSD: 0.07, RecordedAt: at(30)},
		{SessionID: "s2", AgentName: "beta", AgentType: "claude", BoardName: board("team-a"), Model: "claude-sonnet-5-5", Source: "jsonl", InputTokens: 800, OutputTokens: 90, CacheReadTokens: 100, CostUSD: 0.09, RecordedAt: at(5)},
		{SessionID: "s2", AgentName: "beta", AgentType: "claude", BoardName: board("team-a"), Model: "claude-sonnet-5-5", Source: "proxy", InputTokens: 800, OutputTokens: 90, CacheReadTokens: 100, CostUSD: 0.09, RecordedAt: at(5)}, // the same turns, seen by the proxy: counted once
		{SessionID: "s3", AgentName: "gamma", AgentType: "codex", BoardName: board("team-b"), Model: "gpt-5-codex", Source: "jsonl", InputTokens: 5000, OutputTokens: 400, CacheReadTokens: 3000, CostUSD: 0.8, RecordedAt: at(2)},
		{SessionID: "s3", AgentName: "gamma", AgentType: "codex", BoardName: board("team-b"), Model: "gpt-5-codex", Source: "jsonl", InputTokens: 4000, OutputTokens: 200, CostUSD: 0.4, RecordedAt: at(50)},
		{SessionID: "s4", AgentName: "delta", AgentType: "claude", Model: "", Source: "jsonl", InputTokens: 60, OutputTokens: 6, CostUSD: 0.01, RecordedAt: at(2.5)},        // no team, no model
		{SessionID: "s5", AgentName: "eps", AgentType: "codex", Model: "gpt-5-codex", Source: "jsonl", InputTokens: 900, OutputTokens: 90, CostUSD: 0.2, RecordedAt: at(4)}, // team-c is only its session's
	}
	for i := range rows {
		require.NoError(t, ts.RecordUsage(t.Context(), &rows[i]), i)
	}
}

func TestEveryAnalyticsViewAddsUpToTheSameTotals(t *testing.T) {
	ts, r, db := seriesRouter(t)
	r.Get("/api/token-usage/by-team", NewTokenUsageHandler(db).UsageSummaryByBoard)
	now := time.Now().UTC()
	seedConsistency(t, db, ts, now)

	for _, c := range []struct {
		name  string
		since string
	}{{"all time", ""}, {"7 days", now.Add(-7 * 24 * time.Hour).Format(time.RFC3339Nano)}, {"24 hours", now.Add(-24 * time.Hour).Format(time.RFC3339Nano)}, {"3 hours", now.Add(-3 * time.Hour).Format(time.RFC3339Nano)}} {
		q := ""
		if c.since != "" {
			q = "?since=" + url.QueryEscape(c.since)
		}
		var sum map[string]any
		require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/summary"+q, false, &sum))
		totals := figs(sum["totals"].(map[string]any))
		reqs := sum["totals"].(map[string]any)["num_requests"].(float64)

		byType, byModel, byAgent := sum["by_agent_type"].([]any), sum["by_model"].([]any), sum["by_agent"].([]any)
		totals.equal(t, sumRows(byType), "%s: By provider adds up to the tiles", c.name)
		totals.equal(t, sumRows(byModel), "%s: By model adds up to the tiles", c.name)
		totals.equal(t, sumRows(byAgent), "%s: By agent adds up to the tiles", c.name)
		if thinking, ok := sum["by_thinking"].([]any); ok && len(thinking) > 0 {
			totals.equal(t, sumRows(thinking), "%s: By thinking level adds up to the tiles", c.name)
		}
		var n float64
		for _, a := range byAgent {
			n += a.(map[string]any)["requests"].(float64)
		}
		assert.Equal(t, reqs, n, "%s: the Requests tile is the By agent Requests column's sum", c.name)

		var teams struct {
			Teams []any `json:"teams"`
		}
		require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/by-team"+q, false, &teams))
		totals.equal(t, sumRows(teams.Teams), "%s: By team adds up to the tiles", c.name)

		for _, interval := range []string{"1h", "5m", "1d"} {
			sep := "?"
			if q != "" {
				sep = "&"
			}
			var line struct {
				Buckets []map[string]any `json:"buckets"`
			}
			require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries"+q+sep+"interval="+interval, false, &line))
			var all []any
			for _, b := range line.Buckets {
				all = append(all, b)
			}
			totals.equal(t, sumRows(all), "%s, %s buckets: the chart's buckets add up to the tiles", c.name, interval)
			if len(line.Buckets) > 0 {
				assert.InDelta(t, totals.cost, line.Buckets[len(line.Buckets)-1]["cumulative_cost"].(float64), 1e-6, "%s, %s: the cumulative line ends on the Cost tile", c.name, interval)
			}
			var requests float64
			for _, b := range line.Buckets {
				requests += b["num_requests"].(float64)
			}
			assert.Equal(t, reqs, requests, "%s, %s: the buckets' requests are the Requests tile", c.name, interval)
		}

		// each series of a grouped line is its table row
		byKey := func(rows []any, key func(map[string]any) string) map[string]figures {
			out := map[string]figures{}
			for _, row := range rows {
				m := row.(map[string]any)
				out[key(m)] = out[key(m)].plus(figs(m))
			}
			return out
		}
		sv := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
		orDefault := func(s, d string) string {
			if s == "" {
				return d
			}
			return s
		}
		tables := map[string]map[string]figures{
			"team":     byKey(teams.Teams, func(m map[string]any) string { return orDefault(sv(m, "board_name"), "(no team)") }),
			"provider": byKey(byType, func(m map[string]any) string { return sv(m, "agent_type") }),
			"model":    byKey(byModel, func(m map[string]any) string { return orDefault(sv(m, "model"), "unknown") }),
		}
		for group, want := range tables {
			sep := "?"
			if q != "" {
				sep = "&"
			}
			var line struct {
				Buckets []struct {
					Series []map[string]any `json:"series"`
				} `json:"buckets"`
			}
			require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries"+q+sep+"interval=1h&group_by="+group, false, &line))
			got := map[string]figures{}
			for _, b := range line.Buckets {
				for _, s := range b.Series {
					got[s["key"].(string)] = got[s["key"].(string)].plus(figs(s))
				}
			}
			require.Len(t, got, len(want), "%s, by %s: the same rows (%v vs %v)", c.name, group, figureKeys(got), figureKeys(want))
			for k, w := range want {
				if math.IsNaN(w.cost) {
					continue
				}
				got[k].equal(t, w, "%s: the %s line %q is its table row", c.name, group, k)
			}
		}
	}
}

func figureKeys(m map[string]figures) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
