package routes

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #9820 (coral-hub): GET /api/token-usage/summary returns by_agent, one row per session, with no way to leave it out or cap it (about 0.9 MiB for 3,000 sessions). include=totals leaves
// it out (and its query is not run); by_agent_limit=N keeps the N sessions with the most tokens and says how many there were. Neither given: the answer is what it always was.
func TestUsageSummaryByAgentCanBeOmittedOrCapped(t *testing.T) {
	ts, r, _ := seriesRouter(t)
	at := time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04:05.000Z")
	// ten sessions: the tokens rise with the number, the cost falls, so the default (cost) order and the cap's (tokens) order are opposite
	for i := 1; i <= 10; i++ {
		u := store.TokenUsage{SessionID: fmt.Sprintf("s%02d", i), AgentName: fmt.Sprintf("agent%02d", i), AgentType: "claude", Model: "opus", InputTokens: i * 1000, OutputTokens: i,
			CostUSD: float64(11-i) / 10, RecordedAt: at, Source: "jsonl"}
		u.TotalTokens = u.InputTokens + u.OutputTokens
		require.NoError(t, ts.RecordUsage(t.Context(), &u))
	}
	type reply struct {
		ByAgent      []map[string]any `json:"by_agent"`
		ByAgentTotal *int             `json:"by_agent_total"`
		Totals       map[string]any   `json:"totals"`
		ByModel      []any            `json:"by_model"`
	}
	get := func(query string, agent bool) (int, reply, map[string]any) {
		var rep reply
		var raw map[string]any
		code := seriesGet(t, r, "/api/token-usage/summary"+query, agent, &rep)
		seriesGet(t, r, "/api/token-usage/summary"+query, agent, &raw)
		return code, rep, raw
	}
	ids := func(rows []map[string]any) []string {
		var out []string
		for _, row := range rows {
			out = append(out, fmt.Sprint(row["session_id"]))
		}
		return out
	}

	// the default: every session, the most expensive first, and no count
	code, def, raw := get("", false)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, def.ByAgent, 10)
	assert.Equal(t, "s01", ids(def.ByAgent)[0])
	assert.Nil(t, def.ByAgentTotal, "no cap, no count")
	assert.NotContains(t, raw, "by_agent_total")

	// include=totals: no by_agent, everything else as it was
	code, tot, raw := get("?include=totals", false)
	require.Equal(t, http.StatusOK, code)
	assert.NotContains(t, raw, "by_agent")
	assert.Equal(t, def.Totals, tot.Totals)
	assert.Equal(t, len(def.ByModel), len(tot.ByModel))
	assert.Contains(t, raw, "by_agent_type")

	// by_agent_limit=N: the N sessions with the most tokens, with the number there were
	code, top, _ := get("?by_agent_limit=3", false)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"s10", "s09", "s08"}, ids(top.ByAgent), "by tokens, not by cost")
	require.NotNil(t, top.ByAgentTotal)
	assert.Equal(t, 10, *top.ByAgentTotal)
	assert.Equal(t, def.Totals, top.Totals, "the totals are of every session, not of the top ones")
	_, all, _ := get("?by_agent_limit=500", false)
	assert.Len(t, all.ByAgent, 10, "a cap over the count keeps them all")
	require.NotNil(t, all.ByAgentTotal)
	assert.Equal(t, 10, *all.ByAgentTotal)
	_, both, raw := get("?include=totals&by_agent_limit=3", false)
	assert.NotContains(t, raw, "by_agent", "include=totals wins")
	assert.Equal(t, def.Totals, both.Totals)

	// an agent's token never had the list (#5041): the parameters change nothing for it
	for _, q := range []string{"", "?by_agent_limit=3", "?include=totals"} {
		code, _, raw := get(q, true)
		require.Equal(t, http.StatusOK, code, q)
		assert.NotContains(t, raw, "by_agent", q)
	}

	// what is not a count, or a word the route knows, is refused, never read as the default
	for _, q := range []string{"?include=everything", "?include=", "?include=totals,x", "?by_agent_limit=0", "?by_agent_limit=-1", "?by_agent_limit=x", "?by_agent_limit=1.5", "?by_agent_limit=99999999999999999999", "?by_agent_limit=100001"} {
		code, _, _ := get(q, false)
		if q == "?include=" {
			assert.Equal(t, http.StatusOK, code, q+": an empty include is none")
			continue
		}
		assert.Equal(t, http.StatusBadRequest, code, q)
	}
}
