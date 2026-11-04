package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	for _, q := range []string{"?limit=0", "?limit=51", "?limit=x", "?cursor=!!!", "?cursor=bm9waXBl"} {
		code, _ := getUsagePage(t, router, q)
		assert.Equal(t, http.StatusBadRequest, code, q)
	}
}
