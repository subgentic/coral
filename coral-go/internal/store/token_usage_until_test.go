package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8235: GetUsageSummaryByAgentBoardUntil leaves out every row at or after the end, whatever form its stamp has, and an aggregated hour that starts at the end; the hour before the end is
// counted. The end is the series' own form (2006-01-02T15:04:05), as the Spend route passes it. Each row has its own size (a power of two) so a wrong row shows in the sum.
func TestUsageSummaryByAgentBoardUntilStopsAtTheEndSecond(t *testing.T) {
	const end = "2026-10-25T11:00:00"
	rows := []struct {
		at    string
		input int
		in    bool
	}{
		{"2026-10-25T10:00:00Z", 1, true},
		{"2026-10-25T10:59:59Z", 2, true},
		{"2026-10-25T10:59:59.999999+00:00", 4, true},
		{"2026-10-25T11:00:00Z", 8, false}, // the end second itself
		{"2026-10-25T11:00:00", 16, false},
		{"2026-10-25T11:00:00.000000+00:00", 32, false},
		{"2026-10-25T11:59:59Z", 64, false}, // later in the hour that starts at the end
	}
	want := 0
	for _, r := range rows {
		if r.in {
			want += r.input
		}
	}
	require.Equal(t, 7, want)

	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	for _, r := range rows {
		require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: "aaaaaaaa-8257-4000-8000-000000000001", AgentName: "Backend Dev", AgentType: "claude",
			InputTokens: r.input, TotalTokens: r.input, RecordedAt: r.at, Source: "jsonl"}))
	}
	read := func(t *testing.T, until string) int64 {
		t.Helper()
		got, err := s.GetUsageSummaryByAgentBoardUntil(ctx, "2026-10-24T11:00:00Z", until, "")
		require.NoError(t, err)
		require.Len(t, got, 1)
		return got[0].InputTokens
	}

	t.Run("raw rows", func(t *testing.T) {
		tokenUsageHourAggOn = false
		t.Cleanup(func() { tokenUsageHourAggOn = true })
		assert.EqualValues(t, want, read(t, end))
		assert.EqualValues(t, 127, read(t, ""), "no end counts every row")
	})
	t.Run("aggregate not built yet", func(t *testing.T) {
		assert.EqualValues(t, want, read(t, end))
	})
	t.Run("aggregate built", func(t *testing.T) {
		n, err := db.RefreshTokenUsageHourAgg(ctx, time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC), 1000)
		require.NoError(t, err)
		require.Positive(t, n, "the hours were aggregated")
		var aggregated int
		require.NoError(t, db.GetContext(ctx, &aggregated, `SELECT COUNT(*) FROM token_usage_hour_agg WHERE hour IN ('2026-10-25T10', '2026-10-25T11')`))
		require.Equal(t, 2, aggregated, "the hour before the end and the hour that starts at it are both in the aggregate")
		assert.EqualValues(t, want, read(t, end), "the hour that starts at the end is left out of the aggregate, the hour before it counts")
		assert.EqualValues(t, 127, read(t, ""))
	})
}

func TestUsageAgentSummaryPartialHour8624(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	for _, row := range []struct {
		at   string
		cost float64
	}{{"2026-10-26T09:10:00.000Z", 8}, {"2026-10-26T10:10:00.000Z", 1}, {"2026-10-26T10:30:00.000000+00:00", 4}, {"2026-10-26T10:40:00.000Z", 2}} {
		require.NoError(t, s.RecordUsage(t.Context(), &TokenUsage{SessionID: "window", AgentName: "window", AgentType: "claude", RecordedAt: row.at, Source: "jsonl", CostUSD: row.cost}))
	}
	n, err := db.RefreshTokenUsageHourAgg(t.Context(), time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC), 100)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	for _, cut := range []string{"2026-10-26T10:30:00", "2026-10-26T10:30:00Z"} {
		rows, err := s.GetUsageSummaryByAgentBoardUntil(t.Context(), "2026-10-26T08:00:00Z", cut, "")
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, 9.0, rows[0].CostUSD, "%s must use raw rows for the partial last hour", cut)
		assert.Equal(t, 2, rows[0].NumRecords)
	}
}
