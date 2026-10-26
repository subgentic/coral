package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8634 (1): a window that starts at a whole second ("2026-10-25T10:00:00Z", as the dashboard and coral-hub send it) counts the rows recorded in that second, whatever form their stamps have. The stored stamps
// carry fractions ("10:00:00.000Z"), and as text "." sorts before "Z", so the row exactly at the start was left out. Each row has its own size (a power of two) so a wrong row shows in the sum.
func TestUsageSummarySinceCountsTheStartSecondInEveryStampForm(t *testing.T) {
	const since = "2026-10-25T10:00:00Z"
	rows := []struct {
		at    string
		input int
		in    bool
	}{
		{"2026-10-25T09:59:59.999Z", 1, false}, // the second before
		{"2026-10-25T09:59:59Z", 2, false},
		{"2026-10-25T10:00:00Z", 4, true}, // the start second itself, every form
		{"2026-10-25T10:00:00.000Z", 8, true},
		{"2026-10-25T10:00:00.500Z", 16, true},
		{"2026-10-25T10:00:00.000000+00:00", 32, true},
		{"2026-10-25T10:00:00", 64, true},
		{"2026-10-25T10:00:01Z", 128, true},
	}
	want := 0
	for _, r := range rows {
		if r.in {
			want += r.input
		}
	}
	require.Equal(t, 252, want)

	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	for _, r := range rows {
		require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: "aaaaaaaa-8634-4000-8000-000000000001", AgentName: "Backend Dev", AgentType: "claude",
			InputTokens: r.input, TotalTokens: r.input, RecordedAt: r.at, Source: "jsonl"}))
	}
	inputs := func(t *testing.T, since string) int64 {
		t.Helper()
		got, err := s.GetUsageSummaryByAgentBoardUntil(ctx, since, "", "")
		require.NoError(t, err)
		require.Len(t, got, 1)
		return got[0].InputTokens
	}
	t.Run("raw rows", func(t *testing.T) {
		tokenUsageHourAggOn = false
		t.Cleanup(func() { tokenUsageHourAggOn = true })
		assert.EqualValues(t, want, inputs(t, since))
	})
	t.Run("aggregate built", func(t *testing.T) {
		n, err := db.RefreshTokenUsageHourAgg(ctx, time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC), 1000)
		require.NoError(t, err)
		require.Positive(t, n)
		assert.EqualValues(t, want, inputs(t, since))
	})
	t.Run("other forms of the same second", func(t *testing.T) {
		tokenUsageHourAggOn = false
		t.Cleanup(func() { tokenUsageHourAggOn = true })
		for _, form := range []string{"2026-10-25T10:00:00+00:00", "2026-10-25T12:00:00+02:00", "2026-10-25T10:00:00"} {
			assert.EqualValues(t, want, inputs(t, form), form)
		}
	})

	// the other readers of a since
	t.Run("summaries by type, model, board and branch", func(t *testing.T) {
		tokenUsageHourAggOn = false
		t.Cleanup(func() { tokenUsageHourAggOn = true })
		byType, err := s.GetUsageSummary(ctx, since)
		require.NoError(t, err)
		require.Len(t, byType, 1)
		assert.EqualValues(t, want, byType[0].InputTokens)
		byModel, err := s.GetUsageSummaryByModel(ctx, since)
		require.NoError(t, err)
		var sum int64
		for _, m := range byModel {
			sum += m.InputTokens
		}
		assert.EqualValues(t, want, sum)
	})
	t.Run("the time series", func(t *testing.T) {
		for _, interval := range []string{"5m", "1h"} {
			buckets, err := s.GetUsageTimeSeries(ctx, since, interval)
			require.NoError(t, err)
			var sum int64
			for _, b := range buckets {
				sum += b.InputTokens
			}
			assert.EqualValues(t, want, sum, interval)
		}
	})
	t.Run("the per-session list", func(t *testing.T) {
		list, err := s.ListUsage(ctx, UsageFilter{Since: since})
		require.NoError(t, err)
		var sum int
		for _, u := range list {
			sum += u.InputTokens
		}
		assert.Equal(t, want, sum)
	})
}
