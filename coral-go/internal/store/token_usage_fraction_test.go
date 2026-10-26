package store

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsageSinceShortFractionIncludesTheCutoff(t *testing.T) {
	for _, tc := range []struct {
		since string
		ms    int
	}{
		{"2026-10-25T10:00:00.5Z", 500},
		{"2026-10-25T10:00:00.50Z", 500},
		{"2026-10-25T10:00:00.05Z", 50},
		{"2026-10-25T10:00:00.005Z", 5},
		{"2026-10-25T12:00:00.5+02:00", 500},
	} {
		t.Run(tc.since, func(t *testing.T) {
			db := openTestDB(t)
			s := NewTokenUsageStore(db)
			cut := time.Date(2026, 10, 25, 10, 0, 0, tc.ms*int(time.Millisecond), time.UTC)
			for i, row := range []struct {
				at    string
				input int
			}{
				{cut.Add(-time.Millisecond).Format("2006-01-02T15:04:05.000Z"), 1},
				{cut.Format("2006-01-02T15:04:05.000Z"), 2},
				{cut.Format(ISOFormat), 4},
				{cut.Add(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), 8},
				{"2026-10-25T12:00:00.000Z", 16}, // a fully cached hour after the boundary hour
			} {
				require.NoError(t, s.RecordUsage(t.Context(), &TokenUsage{SessionID: fmt.Sprintf("fraction-%d", i), AgentName: "fraction", AgentType: "claude", RecordedAt: row.at, Source: "jsonl", InputTokens: row.input, TotalTokens: row.input}))
			}
			check := func(t *testing.T) {
				t.Helper()
				summary, err := s.GetUsageSummary(t.Context(), tc.since)
				require.NoError(t, err)
				require.Len(t, summary, 1)
				assert.EqualValues(t, 30, summary[0].InputTokens, "summary includes both cutoff spellings, not the previous millisecond")
				agent, err := s.GetUsageSummaryByAgentBoardUntil(t.Context(), tc.since, "", "")
				require.NoError(t, err)
				assert.Len(t, agent, 4)
				var sum int64
				for _, v := range agent {
					sum += v.InputTokens
				}
				assert.EqualValues(t, 30, sum, "agent summary")
				list, err := s.ListUsage(t.Context(), UsageFilter{Since: tc.since})
				require.NoError(t, err)
				sum = 0
				for _, v := range list {
					sum += int64(v.InputTokens)
				}
				assert.EqualValues(t, 30, sum, "list")
				turns, err := s.GetUsageTurns(t.Context(), UsageTurnsQuery{Since: tc.since})
				require.NoError(t, err)
				sum = 0
				for _, v := range turns {
					sum += int64(v.InputTokens)
				}
				assert.EqualValues(t, 30, sum, "turns")
				for _, interval := range []string{"5m", "1h", "1d"} {
					buckets, err := s.GetUsageTimeSeries(t.Context(), tc.since, interval)
					require.NoError(t, err)
					sum = 0
					for _, v := range buckets {
						sum += v.InputTokens
					}
					assert.EqualValues(t, 30, sum, interval)
				}
			}
			t.Run("raw", check)
			n, err := db.RefreshTokenUsageHourAgg(t.Context(), cut.Add(4*time.Hour), 100)
			require.NoError(t, err)
			require.Equal(t, 2, n)
			t.Run("cached", check)
		})
	}
}

func TestUsageSinceDoesNotRoundSubmillisecondCutoffsBackward(t *testing.T) {
	s := NewTokenUsageStore(openTestDB(t))
	for _, row := range []struct {
		at    string
		input int
	}{{"2026-10-25T10:00:00.500000Z", 1}, {"2026-10-25T10:00:00.500200Z", 2}} {
		require.NoError(t, s.RecordUsage(t.Context(), &TokenUsage{SessionID: "precise", AgentName: "fraction", AgentType: "claude", RecordedAt: row.at, Source: "jsonl", InputTokens: row.input, TotalTokens: row.input}))
	}
	got, err := s.GetUsageSummary(t.Context(), "2026-10-25T10:00:00.500100Z")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.EqualValues(t, 2, got[0].InputTokens, "padding a short fraction must not round a precise bound down to .500")
}
