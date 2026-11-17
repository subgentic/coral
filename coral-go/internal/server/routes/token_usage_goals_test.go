package routes

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func TestGoalUsageUsesWorkWindowsAndPreservesTotals(t *testing.T) {
	ts, _, db := seriesRouter(t)
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer bs.Close()
	ctx := context.Background()
	base := seedHours(t, ts)
	// Two overlapping tasks of one session: the later claim owns the second turn.
	goalA, err := bs.CreateGoal(ctx, "team-a", board.GoalInput{Title: "Goal A", CreatedBy: "Operator"})
	require.NoError(t, err)
	goalB, err := bs.CreateGoal(ctx, "team-a", board.GoalInput{Title: "Goal B", CreatedBy: "Operator"})
	require.NoError(t, err)
	for i, start := range []time.Time{base, base.Add(time.Hour)} {
		task, err := bs.CreateTask(ctx, "team-a", "task", "", "medium", "Operator")
		require.NoError(t, err)
		goal := goalA.ID
		if i == 1 {
			goal = goalB.ID
		}
		require.NoError(t, bs.SetTaskGoal(ctx, "team-a", task.ID, &goal))
		_, err = bs.Writer().ExecContext(ctx, `UPDATE board_tasks SET session_id='s1',status='completed',claimed_at=?,completed_at=? WHERE id=?`, start.Format(time.RFC3339), base.Add(2*time.Hour).Format(time.RFC3339), task.ID)
		require.NoError(t, err)
		if i == 0 {
			_, err = bs.Writer().ExecContext(ctx, `UPDATE board_tasks SET work_windows=? WHERE id=?`, `[["`+base.Add(-time.Hour).Format(time.RFC3339)+`","`+base.Format(time.RFC3339)+`"]]`, task.ID)
			require.NoError(t, err)
		}
	}
	h := NewTokenUsageHandler(db)
	h.SetBoardStore(bs)
	var out struct {
		Buckets []store.GroupedBucket `json:"buckets"`
	}
	get := func(group string) {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/token-usage/timeseries?interval=1h&since="+url.QueryEscape(base.Add(-2*time.Hour).Format(time.RFC3339))+group, nil)
		w := httptest.NewRecorder()
		h.UsageTimeSeries(w, req)
		require.Equal(t, 200, w.Code, w.Body.String())
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	}
	get("")
	var plain float64
	var requests int
	for _, b := range out.Buckets {
		plain += b.CostUSD
		requests += b.NumRequests
	}
	get("&group_by=goal")
	var sum float64
	var calls int
	ids := map[int64]bool{}
	var unmatched float64
	goalCosts := map[string]float64{}
	for _, b := range out.Buckets {
		for _, g := range b.Series {
			sum += g.CostUSD
			goalCosts[g.Label] += g.CostUSD
			calls += g.NumRequests
			for _, id := range g.TaskIDs {
				ids[id] = true
			}
			if g.Key == "untasked" {
				unmatched += g.CostUSD
			}
		}
	}
	assert.Equal(t, plain, sum)
	assert.Equal(t, requests, calls)
	assert.Equal(t, 4.0, unmatched)
	assert.Len(t, ids, 2)
	assert.Equal(t, 1.0, goalCosts["Goal A"])
	assert.Equal(t, 2.0, goalCosts["Goal B"])
	// Goal grouping names tasks, just as agent grouping names agents: agent tokens cannot read it.
	require.Equal(t, 403, seriesGet(t, http.HandlerFunc(h.UsageTimeSeries), "/api/token-usage/timeseries?group_by=goal", true, nil))
}

// A rolled hour keeps its original request count. Its work attribution uses the
// hour start, even though recorded_at is the newest turn in that hour.
func TestGoalUsageHourlyAttribution(t *testing.T) {
	ts, _, db := seriesRouter(t)
	ctx := context.Background()
	_, err := db.ExecContext(ctx, `INSERT INTO token_usage_hourly(hour,session_id,agent_name,agent_type,input_tokens,output_tokens,total_tokens,cost_usd,num_turns,recorded_at,cache_read_tokens,cache_write_tokens,source,model,n_rows,ctx_tokens) VALUES('2026-01-01T10','old','Dev','codex',100,20,120,7,9,'2026-01-01T10:59:00Z',0,0,'jsonl','gpt',9,120)`)
	require.NoError(t, err)
	parse := func(s string) time.Time { v, e := time.Parse(time.RFC3339, s); require.NoError(t, e); return v }
	windows := []store.GoalUsageWindow{
		{TaskID: 1, Session: "old", Key: "early", Label: "Early", Claimed: parse("2026-01-01T09:00:00Z"), Ended: parse("2026-01-01T10:30:00Z")},
		{TaskID: 2, Session: "old", Key: "late", Label: "Late", Claimed: parse("2026-01-01T10:30:00Z")},
	}
	q := store.TimeSeriesQuery{Since: "2026-01-01T00:00:00Z", Until: "2026-01-02T00:00:00Z", Interval: "1d"}
	got, err := ts.GoalUsageSeries(ctx, q, windows)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Len(t, got[0].Series, 1)
	assert.Equal(t, "early", got[0].Series[0].Key)
	assert.Equal(t, 9, got[0].Series[0].NumRequests)
	plain, err := ts.GetUsageTimeSeriesGrouped(ctx, q)
	require.NoError(t, err)
	require.Len(t, plain, 1)
	assert.Equal(t, plain[0].TimeSeriesBucket, got[0].TimeSeriesBucket)
}

// #19246: rows of sessions with no work window are summed by the database (one row per minute, not one per request) and only the sessions that have windows are attributed row by row.
// 3000 requests of sessions with no windows and 40 of one that has one: the result is what a row-by-row pass gives (the plain series' totals, the windowed session on its goal, the rest on "Not on a task").
func TestGoalUsageSumsRowsOfSessionsWithoutWindowsInTheDatabase(t *testing.T) {
	ts, _, _ := seriesRouter(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Hour).Add(-3 * time.Hour)
	board := "team-a"
	for i := 0; i < 3000; i++ {
		u := store.TokenUsage{SessionID: "plain-" + string(rune('a'+i%7)), AgentName: "x", AgentType: "claude", BoardName: &board, Model: "m", InputTokens: 10, OutputTokens: 1, TotalTokens: 11, CostUSD: 0.5, Source: "jsonl", RecordedAt: base.Add(time.Duration(i) * time.Second).Format("2006-01-02T15:04:05.000Z")}
		require.NoError(t, ts.RecordUsage(ctx, &u))
	}
	for i := 0; i < 40; i++ {
		u := store.TokenUsage{SessionID: "worker", AgentName: "w", AgentType: "claude", BoardName: &board, Model: "m", InputTokens: 10, OutputTokens: 1, TotalTokens: 11, CostUSD: 2, Source: "jsonl", RecordedAt: base.Add(time.Duration(i) * time.Minute).Format("2006-01-02T15:04:05.000Z")}
		require.NoError(t, ts.RecordUsage(ctx, &u))
	}
	windows := []store.GoalUsageWindow{{TaskID: 9, Session: "worker", Board: board, Key: "team-a/1", Label: "Goal 1", Claimed: base, Ended: base.Add(20 * time.Minute)}}
	q := store.TimeSeriesQuery{Since: base.Add(-time.Hour).Format(time.RFC3339), Interval: "1h"}
	got, err := ts.GoalUsageSeries(ctx, q, windows)
	require.NoError(t, err)
	byKey := map[string]float64{}
	reqs := map[string]int{}
	for _, b := range got {
		for _, s := range b.Series {
			byKey[s.Key] += s.CostUSD
			reqs[s.Key] += s.NumRequests
		}
	}
	assert.InDelta(t, 40, byKey["team-a/1"], 0.001, "the worker's first 20 turns are on its goal")
	assert.InDelta(t, 1500+40, byKey["untasked"], 0.001)
	assert.Equal(t, 3000+20, reqs["untasked"])
	assert.Equal(t, 20, reqs["team-a/1"])
	plain, err := ts.GetUsageTimeSeriesGrouped(ctx, store.TimeSeriesQuery{Since: q.Since, Interval: "1h"})
	require.NoError(t, err)
	var plainCost, goalCost float64
	for _, b := range plain {
		plainCost += b.CostUSD
	}
	for _, b := range got {
		goalCost += b.CostUSD
	}
	assert.InDelta(t, plainCost, goalCost, 0.001, "the goal view and the plain view add up to the same money")
}
