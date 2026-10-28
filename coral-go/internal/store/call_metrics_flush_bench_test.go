package store

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func callMetricsDBWithRows(tb testing.TB, rows int) *DB {
	tb.Helper()
	db, err := OpenWithKey(context.Background(), filepath.Join(tb.TempDir(), "metrics_bench.db"), "")
	require.NoError(tb, err)
	tb.Cleanup(func() { db.Close() })
	tx, err := db.Beginx()
	require.NoError(tb, err)
	stmt, err := tx.Preparex(`INSERT INTO call_metrics(call_type, operation, agent_name, session_id, method, status_code, duration_ms, is_error, created_at) VALUES ('api', ?, 'agent', ?, 'GET', 200, 3, 0, ?)`)
	require.NoError(tb, err)
	now := time.Now().UTC()
	for i := 0; i < rows; i++ {
		_, err := stmt.Exec(fmt.Sprintf("/api/op%d", i%40), fmt.Sprintf("sess-%d", i%30), now.Add(-time.Duration(rows-i)*time.Second).Format(time.RFC3339Nano))
		require.NoError(tb, err)
	}
	require.NoError(tb, stmt.Close())
	require.NoError(tb, tx.Commit())
	return db
}

// BenchmarkCallMetricFlush is one flush of 50 metrics into a table of 400,000 raw rows (#9771): the background writer every poll feeds. go test ./internal/store -run xxx -bench CallMetricFlush -benchtime 40x
func BenchmarkCallMetricFlush(b *testing.B) {
	db := callMetricsDBWithRows(b, 400000)
	ctx := context.Background()
	batch := func() []*CallMetric {
		out := make([]*CallMetric, 50)
		for i := range out {
			out[i] = &CallMetric{CallType: "api", Operation: "/api/sessions/live", Method: "GET", StatusCode: 200, DurationMs: 2, SessionID: "sess-1", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		}
		return out
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		bb := batch()
		b.StartTimer()
		require.NoError(b, db.writeCallMetrics(ctx, bb))
	}
}
