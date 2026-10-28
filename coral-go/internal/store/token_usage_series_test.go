package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seriesBoard(s string) *string { return &s }

// seedSeries records: team-a's alpha (claude, opus) 10:05 and 11:10, team-b's beta (codex, gpt) 11:20, and an agent with no team or model at 12:00.
func seedSeries(t *testing.T, s *TokenUsageStore) {
	t.Helper()
	ctx := context.Background()
	for _, u := range []TokenUsage{
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: seriesBoard("team-a"), Model: "opus", InputTokens: 100, OutputTokens: 10, CacheReadTokens: 1000, CacheWriteTokens: 5, TotalTokens: 110, CostUSD: 1, RecordedAt: "2026-01-01T10:05:00Z"},
		{SessionID: "s1", AgentName: "alpha", AgentType: "claude", BoardName: seriesBoard("team-a"), Model: "opus", InputTokens: 200, OutputTokens: 20, CacheReadTokens: 2000, TotalTokens: 220, CostUSD: 2, RecordedAt: "2026-01-01T11:10:00Z"},
		{SessionID: "s2", AgentName: "beta", AgentType: "codex", BoardName: seriesBoard("team-b"), Model: "gpt", InputTokens: 300, OutputTokens: 30, TotalTokens: 330, CostUSD: 4, RecordedAt: "2026-01-01T11:20:00Z"},
		{SessionID: "s3", AgentName: "gamma", AgentType: "claude", InputTokens: 50, OutputTokens: 5, TotalTokens: 55, CostUSD: 0.5, RecordedAt: "2026-01-01T12:00:00Z"},
	} {
		u := u
		require.NoError(t, s.RecordUsage(ctx, &u))
	}
}

func TestUsageTimeSeriesGrouped_SeriesAreTheTotalsParts(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	ctx := context.Background()
	for _, interval := range []string{"1h", "5m", "1d"} {
		plain, err := s.GetUsageTimeSeries(ctx, "", interval)
		require.NoError(t, err)
		for _, group := range []string{"team", "agent", "provider", "model"} {
			grouped, err := s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{Interval: interval, GroupBy: group})
			require.NoError(t, err)
			require.Len(t, grouped, len(plain), "%s by %s: the same buckets", interval, group)
			for i, b := range grouped {
				assert.Equal(t, plain[i], b.TimeSeriesBucket, "%s by %s: a bucket's figures are the plain series' (the sum of its parts)", interval, group)
				var cost float64
				var in, out, cr, cw int64
				var n int
				for _, x := range b.Series {
					cost += x.CostUSD
					in += x.InputTokens
					out += x.OutputTokens
					cr += x.CacheReadTokens
					cw += x.CacheWriteTokens
					n += x.NumRequests
				}
				assert.InDelta(t, b.CostUSD, cost, 1e-9, "%s by %s %s", interval, group, b.Bucket)
				assert.Equal(t, []int64{b.InputTokens, b.OutputTokens, b.CacheReadTokens, b.CacheWriteTokens, int64(b.NumRequests)}, []int64{in, out, cr, cw, int64(n)}, "%s by %s %s", interval, group, b.Bucket)
			}
		}
	}
}

func TestUsageTimeSeriesGrouped_KeysAndEmptyNames(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	keys := func(group string) map[string][]string {
		grouped, err := s.GetUsageTimeSeriesGrouped(context.Background(), TimeSeriesQuery{Interval: "1h", GroupBy: group})
		require.NoError(t, err)
		out := map[string][]string{}
		for _, b := range grouped {
			for _, x := range b.Series {
				out[b.Bucket] = append(out[b.Bucket], x.Key)
			}
		}
		return out
	}
	assert.Equal(t, map[string][]string{"2026-01-01T10:00:00Z": {"team-a"}, "2026-01-01T11:00:00Z": {"team-a", "team-b"}, "2026-01-01T12:00:00Z": {"(no team)"}}, keys("team"))
	assert.Equal(t, []string{"alpha", "beta"}, keys("agent")["2026-01-01T11:00:00Z"])
	assert.Equal(t, []string{"claude", "codex"}, keys("provider")["2026-01-01T11:00:00Z"])
	assert.Equal(t, []string{"unknown"}, keys("model")["2026-01-01T12:00:00Z"], "a row with no model is named, not dropped")
}

func TestUsageTimeSeriesGrouped_UntilIsExclusiveAndPeriodsPartition(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	ctx := context.Background()
	sum := func(q TimeSeriesQuery) float64 {
		b, err := s.GetUsageTimeSeriesGrouped(ctx, q)
		require.NoError(t, err)
		var c float64
		for _, x := range b {
			c += x.CostUSD
		}
		return c
	}
	all := sum(TimeSeriesQuery{Interval: "5m"})
	first := sum(TimeSeriesQuery{Interval: "5m", Until: "2026-01-01T11:10:00Z"}) // the 11:10 row is not in it
	rest := sum(TimeSeriesQuery{Interval: "5m", Since: "2026-01-01T11:10:00Z"})
	assert.InDelta(t, 1, first, 1e-9)
	assert.InDelta(t, all, first+rest, 1e-9, "a period and the one after it add up to the whole")
	assert.InDelta(t, 3, sum(TimeSeriesQuery{Interval: "5m", Board: "team-a"}), 1e-9, "a board narrows it")
}

func TestUsageTimeSeriesGrouped_BoardAndUnknownGroup(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	ctx := context.Background()
	b, err := s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{Interval: "1d", Board: "team-b", GroupBy: "agent"})
	require.NoError(t, err)
	require.Len(t, b, 1)
	assert.Equal(t, 4.0, b[0].CostUSD)
	require.Len(t, b[0].Series, 1)
	assert.Equal(t, "beta", b[0].Series[0].Key)
	_, err = s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{GroupBy: "folder"})
	assert.Error(t, err)
	assert.True(t, ValidUsageGroup("") && ValidUsageGroup("team") && !ValidUsageGroup("folder"))
}

func TestGetUsageTurns(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	ctx := context.Background()
	turns, err := s.GetUsageTurns(ctx, UsageTurnsQuery{Agent: "alpha", Order: "cost"})
	require.NoError(t, err)
	require.Len(t, turns, 2)
	assert.Equal(t, []float64{2, 1}, []float64{turns[0].CostUSD, turns[1].CostUSD}, "dearest first")
	assert.Equal(t, "opus", turns[0].Model)
	assert.Equal(t, "team-a", turns[0].BoardName)
	assert.EqualValues(t, 2000, turns[0].CacheReadTokens)
	newest, err := s.GetUsageTurns(ctx, UsageTurnsQuery{})
	require.NoError(t, err)
	assert.Equal(t, "gamma", newest[0].AgentName, "the default is newest first")
	window, err := s.GetUsageTurns(ctx, UsageTurnsQuery{Since: "2026-01-01T11:00:00Z", Until: "2026-01-01T12:00:00Z"})
	require.NoError(t, err)
	assert.Len(t, window, 2, "until is exclusive")
	one, err := s.GetUsageTurns(ctx, UsageTurnsQuery{Limit: 1, Order: "cost"})
	require.NoError(t, err)
	require.Len(t, one, 1)
	assert.Equal(t, 4.0, one[0].CostUSD)
	big, err := s.GetUsageTurns(ctx, UsageTurnsQuery{Limit: 100000})
	require.NoError(t, err)
	assert.LessOrEqual(t, len(big), MaxUsageTurns)
}

func TestGetSessionTurns_CarriesTokensAndModel(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	seedSeries(t, s)
	turns, err := s.GetSessionTurns(context.Background(), "s1")
	require.NoError(t, err)
	require.Len(t, turns, 2)
	assert.Equal(t, TurnCost{CostUSD: 1, InputTokens: 100, OutputTokens: 10, CacheReadTokens: 1000, CacheWriteTokens: 5, Model: "opus", RecordedAt: "2026-01-01T10:05:00Z"}, turns[0])
}

// #10272: the By agent chart names a series as the table names its row: the agent's current display name, else the name recorded with its usage, else its folder; only an agent
// with none of them is "(unknown)". A renamed agent's chart line and table row used to disagree, and an unnamed one was "(unknown)" beside a table row with its folder.
func TestAgentSeriesAreNamedAsTheTableNamesThem(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	_, err := db.Exec(`INSERT INTO live_sessions (session_id, agent_type, agent_name, working_dir, created_at, display_name) VALUES
		('unnamed', 'claude', 'a2', '/w/a2', '2026-01-01T00:00:00Z', ''),
		('renamed', 'claude', 'coral-go', '/w/coral-go', '2026-01-01T00:00:00Z', 'Debugger')`)
	require.NoError(t, err)
	for _, u := range []*TokenUsage{
		{SessionID: "unnamed", AgentType: "claude", InputTokens: 1, RecordedAt: "2026-01-01T10:00:00Z"},
		{SessionID: "renamed", AgentName: "Agent", AgentType: "claude", InputTokens: 1, RecordedAt: "2026-01-01T10:00:00Z"},
		{SessionID: "orphan", AgentType: "claude", InputTokens: 1, RecordedAt: "2026-01-01T10:00:00Z"},
	} {
		require.NoError(t, s.RecordUsage(ctx, u))
	}
	b, err := s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{Interval: "1d", GroupBy: "agent"})
	require.NoError(t, err)
	var keys []string
	for _, bk := range b {
		for _, sr := range bk.Series {
			keys = append(keys, sr.Key)
		}
	}
	assert.ElementsMatch(t, []string{"a2", "Debugger", "(unknown)"}, keys)
}
