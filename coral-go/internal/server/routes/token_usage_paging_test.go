package routes

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

type usagePageBody struct {
	Records []struct {
		SessionID string `json:"session_id"`
	} `json:"records"`
	Total      int              `json:"total"`
	NextCursor string           `json:"next_cursor"`
	Agents     []map[string]any `json:"agents"`
	Totals     map[string]any   `json:"totals"`
}

func getUsagePage(t *testing.T, router http.Handler, query string) (int, usagePageBody) {
	t.Helper()
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/token-usage"+query, nil))
	var b usagePageBody
	if w.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &b))
	}
	return w.Code, b
}

// #13187: the rows route answers at most 50 sessions, with the true total and a cursor; the totals and the per-agent rows are over every row.
func TestListUsagePagesFiftyWithATrueTotal(t *testing.T) {
	ts, _, router := setupTokenUsageTest(t)
	ctx := t.Context()
	const n = 120
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < n; i++ {
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{
			SessionID: fmt.Sprintf("s%03d", i), AgentName: fmt.Sprintf("agent-%d", i%3), AgentType: "claude",
			InputTokens: 10, OutputTokens: 5, TotalTokens: 15, CostUSD: 0.01, NumTurns: 2,
			RecordedAt: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano),
		}))
	}

	code, p := getUsagePage(t, router, "")
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, p.Records, 50, "a page is 50 rows, not every session")
	assert.Equal(t, n, p.Total)
	assert.NotEmpty(t, p.NextCursor)
	assert.Equal(t, float64(n), p.Totals["num_sessions"], "the totals count every session, not the page")
	assert.Equal(t, float64(n*15), p.Totals["total_tokens"])
	require.Len(t, p.Agents, 3, "one row per agent over every session")
	assert.Equal(t, float64(40*10), p.Agents[0]["input_tokens"], "an agent's row adds up its 40 sessions")

	// The SQL sums are the plain sums of the rows: read every row back and add them up here.
	all, err := ts.ListUsage(ctx, store.UsageFilter{})
	require.NoError(t, err)
	var in, out, cr, cw, tt int64
	var cost float64
	perAgent := map[string][4]float64{}
	for _, r := range all {
		in += int64(r.InputTokens)
		out += int64(r.OutputTokens)
		cr += int64(r.CacheReadTokens)
		cw += int64(r.CacheWriteTokens)
		tt += int64(r.TotalTokens)
		cost += r.CostUSD
		a := perAgent[r.AgentName]
		perAgent[r.AgentName] = [4]float64{a[0] + float64(r.InputTokens), a[1] + float64(r.OutputTokens), a[2] + r.CostUSD, a[3] + float64(r.NumTurns)}
	}
	assert.Equal(t, float64(in), p.Totals["input_tokens"])
	assert.Equal(t, float64(out), p.Totals["output_tokens"])
	assert.Equal(t, float64(cr), p.Totals["cache_read_tokens"])
	assert.Equal(t, float64(cw), p.Totals["cache_write_tokens"])
	assert.Equal(t, float64(tt), p.Totals["total_tokens"])
	assert.InDelta(t, cost, p.Totals["cost_usd"].(float64), 1e-9)
	require.Len(t, p.Agents, len(perAgent))
	for _, ag := range p.Agents {
		want, ok := perAgent[ag["name"].(string)]
		require.True(t, ok, "an agent row names a session's agent: %v", ag["name"])
		assert.Equal(t, want[0], ag["input_tokens"])
		assert.Equal(t, want[1], ag["output_tokens"])
		assert.InDelta(t, want[2], ag["cost_usd"].(float64), 1e-9)
		assert.Equal(t, want[3], ag["num_turns"])
	}

	seen := map[string]bool{}
	cursor, pages := "", 0
	for {
		q := "?limit=50"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		code, pg := getUsagePage(t, router, q)
		require.Equal(t, http.StatusOK, code)
		pages++
		for _, r := range pg.Records {
			require.False(t, seen[r.SessionID], "a row is sent once: "+r.SessionID)
			seen[r.SessionID] = true
		}
		if pg.NextCursor == "" {
			break
		}
		cursor = pg.NextCursor
		require.Less(t, pages, 10)
	}
	assert.Len(t, seen, n, "the pages together are every session")
	assert.Equal(t, 3, pages)

	// A session that lands between two requests moves the front, not the place: nothing repeats, nothing after the cursor is skipped.
	_, first := getUsagePage(t, router, "?limit=50")
	require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: "late", AgentName: "agent-0", AgentType: "claude", InputTokens: 1, TotalTokens: 1, NumTurns: 1, RecordedAt: time.Now().UTC().Format(time.RFC3339Nano)}))
	_, second := getUsagePage(t, router, "?limit=50&cursor="+first.NextCursor)
	for _, r := range second.Records {
		assert.False(t, seen["late"] && r.SessionID == "late", "the new session is on the front page, not page 2")
	}
	assert.Len(t, second.Records, 50)
}

func TestListUsageRefusesABadLimitOrCursor(t *testing.T) {
	_, _, router := setupTokenUsageTest(t)
	for _, q := range []string{"?limit=0", "?limit=51", "?limit=x", "?cursor=!!!", "?cursor=bm9waXBl", "?cursor=" + strings.Repeat("A", 300), "?cursor=" + base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("x", 200)+"|s"))} {
		code, _ := getUsagePage(t, router, q)
		assert.Equal(t, http.StatusBadRequest, code, q)
	}
}

// An agent reads this file to learn the route: it must say the list is one page of 50 with next_cursor, total and agents, not every row (#13218).
func TestTokenUsageDocSaysTheListIsPaged(t *testing.T) {
	b, err := os.ReadFile("../../../agent_docs/token-usage.md")
	require.NoError(t, err)
	doc := string(b)
	for _, want := range []string{"50", "next_cursor", "total", "agents", "limit", "cursor"} {
		assert.Contains(t, doc, want)
	}
	assert.Contains(t, doc, "| `GET` | `/api/token-usage` | One page of session records (newest activity first) plus totals and a per-agent sum: `limit` (1 to 50, default 50) and `cursor` (the last answer's `next_cursor`); filters: `session_id`, `board_name`, `team_id`, `since`. |", "the table row for the list says what it answers")
	assert.NotContains(t, doc, "Records plus totals", "the old line reads as every row")
}

// Two agents whose sessions were last active at the same instant come back in the order of their lowest session id (the SQL's tie-break), not by name and not by chance.
func TestListUsageAgentsWithTheSameTimeAreOrderedBySessionID(t *testing.T) {
	ts, _, router := setupTokenUsageTest(t)
	ctx := t.Context()
	at := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	for _, r := range []struct{ sid, agent string }{{"s1", "zeta"}, {"s2", "alpha"}, {"s3", "mid"}, {"s4", "zeta"}} {
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: r.sid, AgentName: r.agent, AgentType: "claude", InputTokens: 1, TotalTokens: 1, RecordedAt: at}))
	}
	for i := 0; i < 3; i++ { // the same every time
		_, p := getUsagePage(t, router, "")
		var names []string
		for _, a := range p.Agents {
			names = append(names, a["name"].(string))
		}
		assert.Equal(t, []string{"zeta", "alpha", "mid"}, names, "by each agent's lowest session id: s1, s2, s3")
	}
}
