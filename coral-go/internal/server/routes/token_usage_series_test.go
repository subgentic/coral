package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

func seriesRouter(t *testing.T) (*store.TokenUsageStore, *chi.Mux, *store.DB) {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "series.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewTokenUsageHandler(db)
	r := chi.NewRouter()
	r.Get("/api/token-usage", h.ListUsage)
	r.Get("/api/token-usage/summary", h.UsageSummary)
	r.Get("/api/token-usage/timeseries", h.UsageTimeSeries)
	r.Get("/api/token-usage/turns", h.UsageTurns)
	r.Get("/api/token-usage/session/{sessionID}/turns", h.SessionTurns)
	cm := &CallMetricsHandler{db: db}
	r.Get("/api/call-metrics/summary", cm.Summary)
	return store.NewTokenUsageStore(db), r, db
}

func seriesGet(t *testing.T, r http.Handler, path string, agent bool, into any) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if agent {
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "agent-a"}))
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if into != nil && w.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), into))
	}
	return w.Code
}

func seedHours(t *testing.T, ts *store.TokenUsageStore) time.Time {
	t.Helper()
	base := time.Now().UTC().Truncate(time.Hour).Add(-6 * time.Hour)
	board := func(s string) *string { return &s }
	for i, u := range []store.TokenUsage{
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: board("team-a"), Model: "opus", InputTokens: 100, OutputTokens: 10, CacheReadTokens: 900, TotalTokens: 110, CostUSD: 1, RecordedAt: base.Add(5 * time.Minute).Format("2006-01-02T15:04:05.000Z")},
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: board("team-a"), Model: "opus", InputTokens: 100, OutputTokens: 10, CacheReadTokens: 900, TotalTokens: 110, CostUSD: 2, RecordedAt: base.Add(65 * time.Minute).Format("2006-01-02T15:04:05.000Z")},
		{SessionID: "s2", AgentName: "beta", AgentType: "codex", BoardName: board("team-b"), Model: "gpt", InputTokens: 300, OutputTokens: 30, TotalTokens: 330, CostUSD: 4, RecordedAt: base.Add(70 * time.Minute).Format("2006-01-02T15:04:05.000Z")},
	} {
		u := u
		u.Source = "jsonl"
		require.NoError(t, ts.RecordUsage(t.Context(), &u), i)
	}
	return base
}

// Every view says the same: a grouped series' parts, the plain series, the summary tile and the running total are one number.
func TestTimeseriesGroupedAgreesWithTheSummaryAndThePlainSeries(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	base := seedHours(t, ts)
	since := url.QueryEscape(base.Add(-time.Hour).Format(time.RFC3339))
	type bucket struct {
		Bucket         string  `json:"bucket"`
		CostUSD        float64 `json:"cost_usd"`
		CumulativeCost float64 `json:"cumulative_cost"`
		Series         []struct {
			Key     string  `json:"key"`
			CostUSD float64 `json:"cost_usd"`
		} `json:"series"`
	}
	var sum struct {
		Totals struct {
			CostUSD float64 `json:"cost_usd"`
		} `json:"totals"`
	}
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/summary?since="+since, false, &sum))
	var plain struct{ Buckets []bucket }
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?interval=1h&since="+since, false, &plain))
	assert.Empty(t, plain.Buckets[0].Series, "no group_by, no series: the answer is what it was")
	for _, g := range []string{"team", "agent", "provider", "model"} {
		var got struct {
			GroupBy string `json:"group_by"`
			Buckets []bucket
		}
		require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?interval=1h&group_by="+g+"&since="+since, false, &got), g)
		assert.Equal(t, g, got.GroupBy)
		require.Len(t, got.Buckets, len(plain.Buckets), g)
		var last float64
		for i, b := range got.Buckets {
			var parts float64
			for _, s := range b.Series {
				parts += s.CostUSD
			}
			assert.InDelta(t, b.CostUSD, parts, 1e-9, "%s: the parts of a bucket add up to it", g)
			assert.InDelta(t, plain.Buckets[i].CostUSD, b.CostUSD, 1e-9, "%s: and it is the plain series' bucket", g)
			last = b.CumulativeCost
		}
		assert.InDelta(t, sum.Totals.CostUSD, last, 1e-9, "%s: the running total ends at the summary's total", g)
	}
	var byTeam struct{ Buckets []bucket }
	seriesGet(t, r, "/api/token-usage/timeseries?interval=1h&group_by=team&since="+since, false, &byTeam)
	require.Len(t, byTeam.Buckets, 2)
	assert.Equal(t, "team-a", byTeam.Buckets[0].Series[0].Key)
	require.Len(t, byTeam.Buckets[1].Series, 2)
}

func TestTimeseriesUntilSplitsAPeriodExactly(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	base := seedHours(t, ts)
	cut := base.Add(time.Hour)
	var all, before, after struct {
		Buckets []struct {
			CostUSD float64 `json:"cost_usd"`
		}
	}
	total := func(s struct {
		Buckets []struct {
			CostUSD float64 `json:"cost_usd"`
		}
	}) (c float64) {
		for _, b := range s.Buckets {
			c += b.CostUSD
		}
		return
	}
	s0 := url.QueryEscape(base.Format(time.RFC3339))
	cutQ := url.QueryEscape(cut.Format(time.RFC3339))
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?since="+s0, false, &all))
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?since="+s0+"&until="+cutQ, false, &before))
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries?since="+cutQ, false, &after))
	assert.InDelta(t, 1, total(before), 1e-9, "until is exclusive")
	assert.InDelta(t, total(all), total(before)+total(after), 1e-9, "the period before and the period after are the whole")
}

func TestTimeseriesRefusesWhatItCannotAnswer(t *testing.T) {
	_, r, _ := seriesRouter(t)
	assert.Equal(t, http.StatusBadRequest, seriesGet(t, r, "/api/token-usage/timeseries?group_by=folder", false, nil))
	assert.Equal(t, http.StatusBadRequest, seriesGet(t, r, "/api/token-usage/timeseries?until=yesterday", false, nil))
	assert.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries?group_by=team", true, nil), "an agent's token reads the teams' series")
	assert.Equal(t, http.StatusForbidden, seriesGet(t, r, "/api/token-usage/timeseries?group_by=agent", true, nil), "but not every agent's, by name")
	assert.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries?group_by=agent", false, nil))
}

func TestUsageTurnsRoute(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	base := seedHours(t, ts)
	var out struct {
		Turns []store.UsageTurn `json:"turns"`
	}
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/turns?agent=alpha&order=cost", false, &out))
	require.Len(t, out.Turns, 2)
	assert.Equal(t, []float64{2, 1}, []float64{out.Turns[0].CostUSD, out.Turns[1].CostUSD})
	assert.Equal(t, "team-a", out.Turns[0].BoardName)
	w := url.QueryEscape(base.Add(time.Hour).Format(time.RFC3339))
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/turns?since="+w, false, &out))
	assert.Len(t, out.Turns, 2)
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/turns?agent=nobody", false, &out))
	assert.NotNil(t, out.Turns)
	assert.Empty(t, out.Turns, "none is an empty list, not null")
	for _, bad := range []string{"order=random", "limit=0", "limit=x", "until=soon"} {
		assert.Equal(t, http.StatusBadRequest, seriesGet(t, r, "/api/token-usage/turns?"+bad, false, nil), bad)
	}
	assert.Equal(t, http.StatusForbidden, seriesGet(t, r, "/api/token-usage/turns", true, nil), "it names agents: an agent's token is refused")
}

func TestSessionTurnsCarryTokensAndModel(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	seedHours(t, ts)
	var out struct {
		Turns []struct {
			Turn            int     `json:"turn"`
			CostUSD         float64 `json:"cost_usd"`
			CumulativeCost  float64 `json:"cumulative_cost"`
			InputTokens     int64   `json:"input_tokens"`
			OutputTokens    int64   `json:"output_tokens"`
			CacheReadTokens int64   `json:"cache_read_tokens"`
			Model           string  `json:"model"`
		} `json:"turns"`
	}
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/session/s1/turns", false, &out))
	require.Len(t, out.Turns, 2)
	assert.Equal(t, "opus", out.Turns[0].Model)
	assert.EqualValues(t, []int64{100, 10, 900}, []int64{out.Turns[0].InputTokens, out.Turns[0].OutputTokens, out.Turns[0].CacheReadTokens})
	assert.InDelta(t, 3, out.Turns[1].CumulativeCost, 1e-9)
}

func TestCallMetricsSummaryOverTime(t *testing.T) {
	_, r, db := seriesRouter(t)
	now := time.Now().UTC().Truncate(time.Hour)
	for i := 0; i < 3; i++ {
		_, err := db.Exec(`INSERT INTO call_metrics(call_type, operation, agent_name, is_error, duration_ms, created_at) VALUES('tool', 'Read', 'alpha', ?, 20, ?)`, i%2, now.Add(-time.Hour).Add(time.Minute).Format(time.RFC3339Nano))
		require.NoError(t, err)
	}
	var out struct {
		Interval string `json:"interval"`
		Buckets  []struct {
			Bucket string `json:"bucket"`
			Calls  int    `json:"calls"`
			Errors int    `json:"errors"`
		} `json:"buckets"`
	}
	require.Equal(t, 200, seriesGet(t, r, "/api/call-metrics/summary?interval=1h&hours=6&agent=alpha", false, &out))
	require.Len(t, out.Buckets, 1)
	assert.Equal(t, []int{3, 1}, []int{out.Buckets[0].Calls, out.Buckets[0].Errors})
	assert.Equal(t, now.Add(-time.Hour).Format("2006-01-02T15")+":00:00Z", out.Buckets[0].Bucket)
	require.Equal(t, 200, seriesGet(t, r, "/api/call-metrics/summary?interval=1h&hours=6&agent=nobody", false, &out))
	assert.NotNil(t, out.Buckets)
	assert.Empty(t, out.Buckets)
	assert.Equal(t, http.StatusBadRequest, seriesGet(t, r, "/api/call-metrics/summary?interval=5m", false, nil))
	var plain struct{ Rows []map[string]any }
	require.Equal(t, 200, seriesGet(t, r, "/api/call-metrics/summary?hours=6", false, &plain))
	assert.Len(t, plain.Rows, 1, "without an interval the answer is the summary it was")
}

// GET /api/token-usage answers { records, totals }: a record per session, no by_agent. The team's token-usage dialog groups the records itself (#7987: it read a by_agent that is not here).
func TestListUsageAnswersRecordsAndTotalsForATeam(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	seedHours(t, ts)
	var out map[string]json.RawMessage
	require.Equal(t, 200, seriesGet(t, r, "/api/token-usage?board_name=team-a", false, &out))
	assert.Contains(t, out, "records")
	assert.Contains(t, out, "totals")
	assert.NotContains(t, out, "by_agent")
	var recs []struct {
		AgentName string `json:"agent_name"`
		NumTurns  int    `json:"num_turns"`
	}
	require.NoError(t, json.Unmarshal(out["records"], &recs))
	require.NotEmpty(t, recs)
	assert.Equal(t, "alpha", recs[0].AgentName)
}

// #9113: with no interval named, a range of up to a week is hourly and a longer one (no since is all history) is daily, so the reply is bounded by the range; a named interval is used as named.
func TestDefaultTimeseriesIntervalIsDailyForALongRange(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	rfc := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	for _, c := range []struct {
		name, since, until, want string
	}{
		{"no since is all history", "", "", "1d"},
		{"a day", rfc(24 * time.Hour), "", "1h"},
		{"exactly a week", rfc(7 * 24 * time.Hour), "", "1h"},
		{"a week and a second", rfc(7*24*time.Hour + time.Second), "", "1d"},
		{"a year", rfc(365 * 24 * time.Hour), "", "1d"},
		{"an old week is a week", rfc(400 * 24 * time.Hour), rfc(393 * 24 * time.Hour), "1h"},
		{"until alone is all history up to it", "", rfc(24 * time.Hour), "1d"},
		{"a since that is not a time keeps the old default", "yesterday", "", "1h"},
	} {
		assert.Equal(t, c.want, defaultTimeseriesInterval(c.since, c.until, now), c.name)
	}
}

func TestTimeseriesReplyIsBoundedByTheRangeAndANamedIntervalIsHonoured(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	base := time.Now().UTC().Truncate(time.Hour).Add(-20 * 24 * time.Hour)
	for i := 0; i < 20*24; i++ { // one row an hour for twenty days
		require.NoError(t, ts.RecordUsage(t.Context(), &store.TokenUsage{SessionID: "s1", AgentName: "alpha", AgentType: "claude", Model: "opus", Source: "jsonl", InputTokens: 10, OutputTokens: 1, TotalTokens: 11, CostUSD: 1,
			RecordedAt: base.Add(time.Duration(i)*time.Hour + time.Minute).Format("2006-01-02T15:04:05.000Z")}))
	}
	type reply struct {
		Interval string                      `json:"interval"`
		Buckets  []struct{ CostUSD float64 } `json:"buckets"`
	}
	read := func(q string) reply {
		var out reply
		require.Equal(t, 200, seriesGet(t, r, "/api/token-usage/timeseries"+q, false, &out), q)
		return out
	}
	all := read("")
	assert.Equal(t, "1d", all.Interval)
	assert.LessOrEqual(t, len(all.Buckets), 22, "twenty days of hourly rows are about twenty daily buckets, not 480 hourly ones")
	hourly := read("?interval=1h")
	assert.Equal(t, "1h", hourly.Interval, "a named interval is used as named")
	assert.Len(t, hourly.Buckets, 480)
	week := read("?since=" + url.QueryEscape(time.Now().UTC().Add(-48*time.Hour).Format(time.RFC3339)))
	assert.Equal(t, "1h", week.Interval, "a short range stays hourly")
	sum := func(b reply) (c float64) {
		for _, x := range b.Buckets {
			c += x.CostUSD
		}
		return
	}
	assert.InDelta(t, sum(hourly), sum(all), 1e-9, "the coarser bucket loses no cost: the line still ends at the same total")
}
