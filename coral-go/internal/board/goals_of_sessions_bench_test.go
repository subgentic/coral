package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// goalsOfSessionsStore is a store shaped like the perf seed's (#9771): 5,000 tasks on one board, about 70% completed, a few in progress with a goal and the session that claimed them, 30 sessions (200 tasks in progress).
func goalsOfSessionsStore(tb testing.TB) (*Store, []string) {
	tb.Helper()
	s, err := NewStoreWithKey(filepath.Join(tb.TempDir(), "board_goals_of_sessions.db"), "")
	require.NoError(tb, err)
	tb.Cleanup(func() { s.Close() })
	ctx := context.Background()
	var goalIDs []int64
	for i := 0; i < 40; i++ {
		g, err := s.CreateGoal(ctx, "perfboard", GoalInput{Title: fmt.Sprintf("Goal %d", i)})
		require.NoError(tb, err)
		goalIDs = append(goalIDs, g.ID)
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(tb, err)
	for i := 1; i <= 5000; i++ {
		status := "completed"
		var session, claimed, goal any
		switch {
		case i%25 == 0:
			status = "in_progress"
			session = fmt.Sprintf("sess-%d", i%30)
			claimed = fmt.Sprintf("2026-10-%02dT10:00:00Z", 1+i%27)
		case i%10 < 3:
			status = "pending"
		}
		if i%2 == 0 {
			goal = goalIDs[i%len(goalIDs)]
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, priority, created_by, session_id, claimed_at, created_at, goal_id, assigned_to) VALUES ('perfboard', ?, ?, 'medium', 'Orch', ?, ?, '2026-10-01T00:00:00Z', ?, ?)`,
			fmt.Sprintf("Task %d", i), status, session, claimed, goal, session)
		require.NoError(tb, err)
	}
	require.NoError(tb, tx.Commit())
	ids := make([]string, 30)
	for i := range ids {
		ids[i] = fmt.Sprintf("sess-%d", i)
	}
	return s, ids
}

// BenchmarkGoalsOfSessions is the live sessions list's goal lookup for 30 sessions: go test ./internal/board -run xxx -bench GoalsOfSessions -benchtime 1000x
func BenchmarkGoalsOfSessions(b *testing.B) {
	s, ids := goalsOfSessionsStore(b)
	ctx := context.Background()
	got, err := s.GoalsOfSessions(ctx, ids)
	require.NoError(b, err)
	b.ReportMetric(float64(len(got)), "sessions_with_goal")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := s.GoalsOfSessions(ctx, ids)
		require.NoError(b, err)
	}
}
