package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// listOpenStatesBoard is a board shaped like the perf seed's (#9745): 5,000 tasks, about 70% completed, the rest pending with a few in progress, blocked and draft, some with prerequisites.
func listOpenStatesBoard(tb testing.TB) *Store {
	tb.Helper()
	s, err := NewStoreWithKey(filepath.Join(tb.TempDir(), "board_open_states.db"), "")
	require.NoError(tb, err)
	tb.Cleanup(func() { s.Close() })
	ctx := context.Background()
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(tb, err)
	prio := []string{"critical", "high", "medium", "low"}
	for i := 1; i <= 5000; i++ {
		status := "completed"
		switch {
		case i%10 < 3:
			status = "pending"
		case i%97 == 0:
			status = "in_progress"
		case i%89 == 0:
			status = "blocked"
		case i%83 == 0:
			status = "draft"
		}
		var assigned any
		if status == "in_progress" {
			assigned = fmt.Sprintf("agent%d", i%30)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, priority, created_by, assigned_to, created_at, completed_at, body) VALUES ('perfboard', ?, ?, ?, 'Orchestrator', ?, '2026-10-01T00:00:00Z', CASE WHEN ? = 'completed' THEN '2026-10-02T00:00:00Z' END, 'The body of a task explains what to do and how to check it.')`,
			fmt.Sprintf("Task %d: make the thing better", i), status, prio[i%4], assigned, status)
		require.NoError(tb, err)
	}
	require.NoError(tb, tx.Commit())
	return s
}

// BenchmarkListOpenTaskStates is the board status read's task read: go test ./internal/board -run xxx -bench ListOpenTaskStates -benchtime 200x
func BenchmarkListOpenTaskStates(b *testing.B) {
	s := listOpenStatesBoard(b)
	ctx := context.Background()
	got, err := s.ListOpenTaskStates(ctx, "perfboard")
	require.NoError(b, err)
	b.ReportMetric(float64(len(got)), "open_tasks")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := s.ListOpenTaskStates(ctx, "perfboard")
		require.NoError(b, err)
	}
}

// BenchmarkListOpenTaskStatesBefore is the read as it was before #9745 (list_open_states_oracle_test.go), for the before and after on one board in one run.
func BenchmarkListOpenTaskStatesBefore(b *testing.B) {
	s := listOpenStatesBoard(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := oldListOpenTaskStates(ctx, s, "perfboard")
		require.NoError(b, err)
	}
}
