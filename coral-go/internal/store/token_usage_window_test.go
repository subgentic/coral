package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8634: a window that ends inside an hour reads that hour from the raw rows, not whole from the hourly aggregate, so two adjacent windows [A, M) and [M, B) add up to [A, B).
// Each row has its own size (a power of two) so a wrong row shows in the sum.
func TestUsageWindowsEndingMidHourDoNotDoubleCount(t *testing.T) {
	rows := []struct {
		at    string
		input int
	}{
		{"2026-10-25T09:10:00.000Z", 1},
		{"2026-10-25T10:05:00.000Z", 2}, // before the middle, same hour
		{"2026-10-25T10:29:59.999Z", 4},
		{"2026-10-25T10:30:00.000Z", 8}, // at the middle
		{"2026-10-25T10:50:00Z", 16},    // after the middle, same hour
		{"2026-10-25T11:20:00.000Z", 32},
		{"2026-10-25T12:00:00.000Z", 64},
	}
	const from, mid, to = "2026-10-25T09:00:00", "2026-10-25T10:30:00", "2026-10-25T13:00:00"

	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	for _, r := range rows {
		require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: "aaaaaaaa-8634-4000-8000-000000000001", AgentName: "Backend Dev", AgentType: "claude",
			InputTokens: r.input, TotalTokens: r.input, RecordedAt: r.at, Source: "jsonl"}))
	}
	sum := func(t *testing.T, since, until string) int64 {
		t.Helper()
		got, err := s.GetUsageSummaryByAgentBoardUntil(ctx, since+"Z", until, "")
		require.NoError(t, err)
		if len(got) == 0 {
			return 0
		}
		return got[0].InputTokens
	}
	series := func(t *testing.T, since, until string) int64 {
		t.Helper()
		got, err := s.GetUsageTimeSeriesGrouped(ctx, TimeSeriesQuery{Since: since + "Z", Until: until, Interval: "1h"})
		require.NoError(t, err)
		var n int64
		for _, b := range got {
			n += int64(b.InputTokens)
		}
		return n
	}
	check := func(t *testing.T) {
		t.Helper()
		assert.EqualValues(t, 127, sum(t, from, to), "the whole window")
		assert.EqualValues(t, 1+2+4, sum(t, from, mid), "up to the middle")
		assert.EqualValues(t, 8+16+32+64, sum(t, mid, to), "from the middle on")
		assert.EqualValues(t, 127, sum(t, from, mid)+sum(t, mid, to), "adjacent windows add up to the whole")
		assert.EqualValues(t, 1+2+4, series(t, from, mid), "series up to the middle")
		assert.EqualValues(t, 8+16+32+64, series(t, mid, to), "series from the middle on")
	}
	t.Run("raw rows", func(t *testing.T) {
		tokenUsageHourAggOn = false
		t.Cleanup(func() { tokenUsageHourAggOn = true })
		check(t)
	})
	t.Run("aggregate built", func(t *testing.T) {
		n, err := db.RefreshTokenUsageHourAgg(ctx, time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC), 1000)
		require.NoError(t, err)
		require.Positive(t, n)
		check(t)
	})
}
