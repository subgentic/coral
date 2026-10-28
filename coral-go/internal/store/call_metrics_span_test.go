package store

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The raw rows' id span is read with two seeks, not a scan of the table (#9771), and is the same number as before: MAX(id) - MIN(id) + 1, 0 for an empty table, gaps counted.
func TestCallMetricSpanIsReadWithSeeksAndIsTheSameNumber(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	const q = `SELECT COALESCE((SELECT MAX(id) FROM call_metrics) - (SELECT MIN(id) FROM call_metrics) + 1, 0)`
	span := func() int64 {
		var n int64
		require.NoError(t, db.GetContext(ctx, &n, q))
		return n
	}
	var old int64
	oldSpan := func() int64 {
		require.NoError(t, db.GetContext(ctx, &old, `SELECT COALESCE(MAX(id) - MIN(id) + 1, 0) FROM call_metrics`))
		return old
	}
	assert.Equal(t, int64(0), span(), "an empty table")
	assert.Equal(t, oldSpan(), span())
	for i := 0; i < 20; i++ {
		_, err := db.ExecContext(ctx, `INSERT INTO call_metrics(call_type, operation, created_at) VALUES ('api', '/x', '2026-10-28T00:00:00Z')`)
		require.NoError(t, err)
	}
	assert.Equal(t, int64(20), span())
	_, err := db.ExecContext(ctx, `DELETE FROM call_metrics WHERE id <= 5 OR id = 12`)
	require.NoError(t, err)
	assert.Equal(t, int64(15), span(), "the oldest five gone: 6 to 20; a gap inside counts")
	assert.Equal(t, oldSpan(), span())

	rows, err := db.QueryxContext(ctx, `EXPLAIN QUERY PLAN `+q)
	require.NoError(t, err)
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, x int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &x, &detail))
		plan = append(plan, detail)
	}
	all := strings.Join(plan, "\n")
	assert.NotContains(t, all, "SCAN call_metrics", "the span is two seeks: %s", all)
}
