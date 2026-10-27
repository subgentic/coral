package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #9512: hostile query parameters on the usage routes whose SQL changed (#9482 turns, #9442/#9447/#9448 the windows of the summary and the time series). Every answer is a 200 with a
// JSON body or a 4xx, never a 5xx; and on valid input the rows are the ones a plain SQL over the table names (the oracle below, not the store's own code).

var hostileTimes = []string{
	"", "soon", "2026-13-45T99:99:99Z", "0000-00-00T00:00:00Z", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "99999-01-01T00:00:00Z", "-0001-01-01T00:00:00Z", "1970-01-01T00:00:00Z",
	"2026-10-27", "2026-10-27 12:00:00", "2026-10-27T12:00:00+25:00", "2026-10-27T12:00:00.123456789012Z", "2026-10-27T12:00:00-07:00", "1e9", "-1", "0", "NaN", "null", "true",
	"'; DROP TABLE token_usage; --", "%", "_", "\\", "\"", strings.Repeat("9", 5000), strings.Repeat("a", 5000), "\x00", "2026-10-27T12:00:00Z\x00", "😀", "\u202e",
	"2026-10-27T12:00:00Z' OR '1'='1", " 2026-10-27T12:00:00Z", "2026-10-27T12:00:00Z ",
}

var hostileLimits = []string{
	"", "0", "-1", "-9223372036854775808", "1", "200", "201", "999999999", "9223372036854775807", "9223372036854775808", "99999999999999999999", "1.5", "1e3", "0x10", " 5", "5 ", "+5", "x", "'", "\x00", "NaN",
	strings.Repeat("9", 400),
}

var hostileText = []string{"", "alpha", "s1", "%", "_", "'", "\"", "' OR 1=1 --", "\\", strings.Repeat("a", 5000), "\x00", "😀", "a\nb", "../../etc/passwd", "ALPHA", "alpha ", "al%", "s1' --"}

var hostileOrders = []string{"", "cost", "time", "COST", "random", "cost,time", "cost; DROP TABLE token_usage", "1", "\x00", "-cost", " cost"}

var hostileIntervals = []string{"", "5m", "1h", "1d", "1w", "1y", "0", "-1", "15m", "1H", "1D", "'", "\x00", "all", "1d;1h", strings.Repeat("1d", 500)}

var hostileGroups = []string{"", "team", "agent", "provider", "model", "folder", "TEAM", "'", "\x00", "team,agent", "__proto__", "model\x00"}

// hostileSeed puts a few hundred turns over three weeks in the table: eight sessions of four agents on three boards, several models, tied costs (so the order's tie-breaks matter).
func hostileSeed(t *testing.T, ts *store.TokenUsageStore) {
	t.Helper()
	rng := rand.New(rand.NewSource(9512))
	start := time.Now().UTC().Truncate(time.Hour).Add(-21 * 24 * time.Hour)
	agents := []string{"alpha", "beta", "gamma", "delta"}
	boards := []string{"team-a", "team-b", ""}
	models := []string{"opus", "gpt", "", "sonnet"}
	for i := 0; i < 320; i++ {
		s := rng.Intn(8)
		board := boards[s%3]
		u := store.TokenUsage{
			SessionID: fmt.Sprintf("s%d", s), AgentName: agents[s%4], AgentType: []string{"claude", "codex"}[s%2], Model: models[rng.Intn(len(models))],
			InputTokens: rng.Intn(5000), OutputTokens: rng.Intn(500), CacheReadTokens: rng.Intn(9000), CostUSD: float64(rng.Intn(6)) / 4, // many ties
			RecordedAt: start.Add(time.Duration(rng.Intn(21*24*60)) * time.Minute).Format("2006-01-02T15:04:05.000Z"), Source: "jsonl",
		}
		u.TotalTokens = u.InputTokens + u.OutputTokens
		if board != "" {
			u.BoardName = &board
		}
		require.NoError(t, ts.RecordUsage(t.Context(), &u), i)
	}
}

func usageGet(t *testing.T, r http.Handler, route string, q url.Values, agent bool) (int, []byte) {
	t.Helper()
	path := route
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var code int
	var body []byte
	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("%s panicked: %v", path[:min(len(path), 200)], p)
			}
		}()
		req, w := newHostileRequest(path, agent)
		r.ServeHTTP(w, req)
		code, body = w.Code, w.Body.Bytes()
	}()
	return code, body
}

func TestUsageRoutesNeverFiveHundredOnHostileParams(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	hostileSeed(t, ts)
	rng := rand.New(rand.NewSource(95121))
	pick := func(vs []string) string { return vs[rng.Intn(len(vs))] }
	routes := []string{"/api/token-usage/turns", "/api/token-usage/summary", "/api/token-usage/timeseries"}
	checked, ok200, refused := 0, 0, 0
	check := func(route string, q url.Values, agent bool) {
		t.Helper()
		code, body := usageGet(t, r, route, q, agent)
		checked++
		desc := fmt.Sprintf("%s %q (agent token %v)", route, q.Encode()[:min(len(q.Encode()), 240)], agent)
		require.Less(t, code, 500, "%s: %s", desc, string(body[:min(len(body), 300)]))
		switch {
		case code == 200:
			ok200++
			var any map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(body, &any), "%s: a 200 is JSON", desc)
		case code >= 400:
			refused++
		}
	}
	// each parameter alone, hostile, on every route
	for _, route := range routes {
		for _, agent := range []bool{false, true} {
			for _, v := range hostileTimes {
				check(route, url.Values{"since": {v}}, agent)
				check(route, url.Values{"until": {v}}, agent)
			}
			for _, v := range hostileLimits {
				check(route, url.Values{"limit": {v}}, agent)
			}
			for _, v := range hostileText {
				check(route, url.Values{"agent": {v}}, agent)
				check(route, url.Values{"session": {v}}, agent)
				check(route, url.Values{"session_id": {v}}, agent)
				check(route, url.Values{"board": {v}}, agent)
			}
			for _, v := range hostileOrders {
				check(route, url.Values{"order": {v}}, agent)
			}
			for _, v := range hostileIntervals {
				check(route, url.Values{"interval": {v}}, agent)
			}
			for _, v := range hostileGroups {
				check(route, url.Values{"group_by": {v}}, agent)
			}
		}
	}
	// since against until, every pair of the hostile times, and random mixes of everything
	for _, route := range routes {
		for _, a := range hostileTimes {
			for _, b := range hostileTimes {
				check(route, url.Values{"since": {a}, "until": {b}}, false)
			}
		}
		for i := 0; i < 400; i++ {
			check(route, url.Values{"since": {pick(hostileTimes)}, "until": {pick(hostileTimes)}, "limit": {pick(hostileLimits)}, "order": {pick(hostileOrders)}, "agent": {pick(hostileText)},
				"session_id": {pick(hostileText)}, "interval": {pick(hostileIntervals)}, "group_by": {pick(hostileGroups)}, "board": {pick(hostileText)}}, i%7 == 0)
		}
	}
	assert.Greater(t, ok200, 500, "most calls are answered")
	assert.Greater(t, refused, 500, "and the invalid ones are refused")
	t.Logf("%d hostile requests: %d answered 200, %d refused with a 4xx, none a 5xx", checked, ok200, refused)
}

// On valid input the turns are the rows a plain SQL over the table gives, in the order asked, at the limit asked (the default 20, at most 200).
func TestUsageTurnsRouteMatchesPlainSQL(t *testing.T) {
	ts, r, db := seriesRouter(t)
	hostileSeed(t, ts)
	type row struct {
		SessionID  string  `db:"session_id"`
		CostUSD    float64 `db:"cost_usd"`
		RecordedAt string  `db:"recorded_at"`
		ID         int64   `db:"id"`
	}
	now := time.Now().UTC()
	// two instants that rows were recorded at: since includes its instant, until does not
	var edge []string
	require.NoError(t, db.SelectContext(t.Context(), &edge, `SELECT recorded_at FROM token_usage ORDER BY id LIMIT 2 OFFSET 40`))
	require.Len(t, edge, 2)
	// an agent with two turns at one instant (one minute and a half before the first edge): small windows on it show whether since includes it and until does not
	pinned := time.Now().UTC().Truncate(time.Hour).Add(-5*24*time.Hour - 90*time.Second)
	for i := 0; i < 2; i++ {
		require.NoError(t, ts.RecordUsage(t.Context(), &store.TokenUsage{SessionID: "se", AgentName: "edge-agent", AgentType: "claude", InputTokens: 1, OutputTokens: 1, TotalTokens: 2, CostUSD: 0.5, Source: "jsonl", RecordedAt: pinned.Format("2006-01-02T15:04:05.000Z")}))
	}
	edge = append(edge, pinned.Format(time.RFC3339Nano), pinned.Add(time.Second).Format(time.RFC3339Nano))
	times := []string{"", edge[0], edge[1], edge[2], edge[3], now.Add(-20 * 24 * time.Hour).Format(time.RFC3339), now.Add(-10 * 24 * time.Hour).Format(time.RFC3339Nano), now.Add(-time.Hour).Format(time.RFC3339), now.Add(24 * time.Hour).Format(time.RFC3339), "2001-01-01T00:00:00Z"}
	cases := 0
	for _, order := range []string{"", "cost", "time"} {
		for _, limit := range []string{"", "1", "7", "20", "199", "200", "201", "300", "400", "401", "5000"} {
			for _, agent := range []string{"", "alpha", "nobody", "edge-agent"} {
				for _, session := range []string{"", "s3"} {
					for _, since := range times {
						for _, until := range times {
							q := url.Values{}
							for k, v := range map[string]string{"order": order, "limit": limit, "agent": agent, "session_id": session, "since": since, "until": until} {
								if v != "" {
									q.Set(k, v)
								}
							}
							code, body := usageGet(t, r, "/api/token-usage/turns", q, false)
							require.Equal(t, 200, code, "%s: %s", q.Encode(), body)
							var out struct {
								Turns []store.UsageTurn `json:"turns"`
							}
							require.NoError(t, json.Unmarshal(body, &out))
							// the oracle: the same window and filters in plain SQL over token_usage (every seeded row is one source), ordered as the route says
							where, args := []string{"1=1"}, []any{}
							if agent != "" {
								where, args = append(where, "agent_name = ?"), append(args, agent)
							}
							if session != "" {
								where, args = append(where, "session_id = ?"), append(args, session)
							}
							if since != "" {
								st, err := time.Parse(time.RFC3339Nano, since)
								require.NoError(t, err)
								where, args = append(where, "recorded_at >= ?"), append(args, st.UTC().Format("2006-01-02T15:04:05.000Z"))
							}
							if until != "" {
								ut, err := time.Parse(time.RFC3339Nano, until)
								require.NoError(t, err)
								where, args = append(where, "recorded_at < ?"), append(args, ut.UTC().Format("2006-01-02T15:04:05.000Z"))
							}
							ord := "recorded_at DESC, id DESC"
							if order == "cost" {
								ord = "cost_usd DESC, recorded_at DESC, id DESC"
							}
							n := 20
							if limit != "" {
								n = min(atoiOr(limit, 20), 200)
							}
							var want []row
							require.NoError(t, db.SelectContext(t.Context(), &want, `SELECT session_id, cost_usd, recorded_at, id FROM token_usage WHERE `+strings.Join(where, " AND ")+` ORDER BY `+ord+fmt.Sprintf(" LIMIT %d", n), args...))
							require.Len(t, out.Turns, len(want), "%s", q.Encode())
							for i, w := range want {
								assert.Equal(t, w.SessionID, out.Turns[i].SessionID, "%s row %d", q.Encode(), i)
								assert.Equal(t, w.CostUSD, out.Turns[i].CostUSD, "%s row %d", q.Encode(), i)
								assert.Equal(t, w.RecordedAt, out.Turns[i].RecordedAt, "%s row %d", q.Encode(), i)
							}
							cases++
						}
					}
				}
			}
		}
	}
	t.Logf("%d valid turns queries compared with plain SQL", cases)
}

func atoiOr(s string, def int) int {
	n := 0
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return def
	}
	return n
}

// A window that ends before it starts, or that lies wholly before or after the data, holds nothing; and the summary, the series and the turns agree about the window that holds everything.
func TestUsageWindowsAreEmptyWhereTheyShouldBe(t *testing.T) {
	ts, r, db := seriesRouter(t)
	hostileSeed(t, ts)
	now := time.Now().UTC()
	past, future := now.Add(-40*24*time.Hour).Format(time.RFC3339), now.Add(40*24*time.Hour).Format(time.RFC3339)
	var totalCost float64
	var totalTokens int64
	require.NoError(t, db.GetContext(t.Context(), &totalCost, `SELECT COALESCE(SUM(cost_usd), 0) FROM token_usage`))
	require.NoError(t, db.GetContext(t.Context(), &totalTokens, `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM token_usage`))
	summary := func(q url.Values) (cost float64, tokens int64) {
		code, body := usageGet(t, r, "/api/token-usage/summary", q, false)
		require.Equal(t, 200, code, q.Encode())
		var out struct {
			Totals struct {
				CostUSD     float64 `json:"cost_usd"`
				InputTokens int64   `json:"input_tokens"`
				Output      int64   `json:"output_tokens"`
			} `json:"totals"`
		}
		require.NoError(t, json.Unmarshal(body, &out))
		return out.Totals.CostUSD, out.Totals.InputTokens + out.Totals.Output
	}
	series := func(q url.Values) (cost float64, buckets int) {
		code, body := usageGet(t, r, "/api/token-usage/timeseries", q, false)
		require.Equal(t, 200, code, q.Encode())
		var out struct {
			Buckets []struct {
				CostUSD float64 `json:"cost_usd"`
			} `json:"buckets"`
		}
		require.NoError(t, json.Unmarshal(body, &out))
		for _, b := range out.Buckets {
			cost += b.CostUSD
		}
		return cost, len(out.Buckets)
	}
	// everything: since far in the past
	c, tk := summary(url.Values{"since": {past}})
	assert.InDelta(t, totalCost, c, 1e-6, "the summary's cost is the table's")
	assert.Equal(t, totalTokens, tk, "and its tokens")
	for _, interval := range []string{"", "5m", "1h", "1d"} {
		sc, n := series(url.Values{"since": {past}, "interval": {interval}})
		assert.InDelta(t, totalCost, sc, 1e-6, "the %q series adds up to the table's cost", interval)
		assert.Greater(t, n, 0)
	}
	// nothing: since in the future, since after until, until before the data
	c, tk = summary(url.Values{"since": {future}})
	assert.Zero(t, c)
	assert.Zero(t, tk)
	for _, interval := range []string{"", "5m", "1h", "1d"} {
		for _, q := range []url.Values{
			{"since": {future}}, {"since": {now.Format(time.RFC3339)}, "until": {past}}, {"since": {past}, "until": {past}}, {"until": {past}},
			{"since": {now.Add(-time.Hour).Format(time.RFC3339)}, "until": {now.Add(-2 * time.Hour).Format(time.RFC3339)}},
		} {
			q.Set("interval", interval)
			sc, n := series(q)
			assert.Zero(t, sc, "series %s", q.Encode())
			assert.Zero(t, n, "series %s: no buckets", q.Encode())
		}
	}
	code, body := usageGet(t, r, "/api/token-usage/turns", url.Values{"since": {now.Format(time.RFC3339)}, "until": {past}}, false)
	require.Equal(t, 200, code)
	assert.JSONEq(t, `{"turns":[]}`, string(body))
}

func newHostileRequest(path string, agent bool) (*http.Request, *httptest.ResponseRecorder) {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if agent {
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "agent-a"}))
	}
	return req, httptest.NewRecorder()
}
