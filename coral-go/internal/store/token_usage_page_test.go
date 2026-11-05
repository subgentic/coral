package store_test

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13218: a page is cut in SQL: ListUsagePage returns the rows past a place, at most limit, in ListUsage's order; the totals and the per-agent rows are SQL sums over every match.
func TestListUsagePageIsCutInSQLAndTheSumsCoverEveryRow(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "page.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ts := store.NewTokenUsageStore(db)
	ctx := t.Context()
	base := time.Now().UTC().Add(-time.Hour)
	const n = 30
	for i := 0; i < n; i++ {
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: fmt.Sprintf("s%02d", i), AgentName: fmt.Sprintf("a%d", i%2), AgentType: "claude",
			InputTokens: 10, TotalTokens: 10, CostUSD: 0.5, RecordedAt: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano)}))
	}
	all, err := ts.ListUsage(ctx, store.UsageFilter{})
	require.NoError(t, err)
	require.Len(t, all, n)

	first, err := ts.ListUsagePage(ctx, store.UsageFilter{}, nil, 11)
	require.NoError(t, err)
	require.Len(t, first, 11, "limit rows, not every session")
	for i := range first {
		assert.Equal(t, all[i].SessionID, first[i].SessionID)
	}
	after := &store.UsageAfter{RecordedAt: first[9].RecordedAt, SessionID: first[9].SessionID}
	next, err := ts.ListUsagePage(ctx, store.UsageFilter{}, after, 100)
	require.NoError(t, err)
	require.Len(t, next, n-10)
	assert.Equal(t, all[10].SessionID, next[0].SessionID, "the page continues right after the place")

	tot, err := ts.UsageTotalsFor(ctx, store.UsageFilter{})
	require.NoError(t, err)
	assert.EqualValues(t, n, tot.Sessions)
	assert.EqualValues(t, n*10, tot.InputTokens)
	assert.InDelta(t, float64(n)*0.5, tot.CostUSD, 1e-9)
	ag, err := ts.UsageByAgent(ctx, store.UsageFilter{})
	require.NoError(t, err)
	require.Len(t, ag, 2)
	assert.EqualValues(t, 150, ag[0].InputTokens)
}
