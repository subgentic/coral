package board

import (
	"context"
	"fmt"
	"math/rand"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// oldListOpenTaskStates is ListOpenTaskStates as it was before #9745: the rows ordered by the database and scanned by sqlx.
func oldListOpenTaskStates(ctx context.Context, s *Store, project string) ([]Task, error) {
	var tasks []Task
	err := s.reader().SelectContext(ctx, &tasks,
		`SELECT id, revision, board_id, title, status, priority, created_by, assigned_to, created_at, claimed_at, parked_reason, parked_until, remind_at, goal_id, `+updatedAtSQL+` AS updated_at FROM board_tasks
		 WHERE board_id = ? AND status IN ('pending', 'in_progress', 'blocked', 'draft')
		 ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, id ASC`,
		project)
	if err != nil {
		return nil, err
	}
	s.loadOpenBlockedBy(ctx, tasks, project)
	return tasks, nil
}

// The open task states are the same tasks in the same order as before, field for field, on boards of every status, priority and null (#9745).
func TestListOpenTaskStatesMatchesTheOldRead(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	rng := rand.New(rand.NewSource(9745))
	statuses := []string{"pending", "in_progress", "blocked", "draft", "completed", "skipped", "review_pending"}
	prios := []string{"critical", "high", "medium", "low"}
	nonEmpty := 0
	for _, board := range []string{"alpha", "beta", "empty"} {
		g := newGoal(t, s, board, "A goal")
		n := 0
		if board != "empty" {
			n = 150
		}
		for i := 0; i < n; i++ {
			status := statuses[rng.Intn(len(statuses))]
			var assigned, claimed, parkedReason, parkedUntil, remind any
			var goal any
			if rng.Intn(2) == 0 {
				assigned = fmt.Sprintf("agent%d", rng.Intn(5))
			}
			if rng.Intn(3) == 0 {
				claimed = "2026-10-05T10:00:00Z"
			}
			if rng.Intn(5) == 0 {
				parkedReason, parkedUntil = "waiting for a review", "2026-12-01T00:00:00Z"
			}
			if rng.Intn(6) == 0 {
				remind = "2026-11-01T00:00:00Z"
			}
			if rng.Intn(2) == 0 {
				goal = g.ID
			}
			_, err := s.db.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, priority, created_by, assigned_to, created_at, claimed_at, parked_reason, parked_until, remind_at, goal_id, completed_at, last_activity_at, edited_at)
				VALUES (?, ?, ?, ?, 'Orch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				board, fmt.Sprintf("task %d", i), status, prios[rng.Intn(4)], assigned, fmt.Sprintf("2026-10-%02dT09:00:00Z", 1+rng.Intn(27)), claimed, parkedReason, parkedUntil, remind, goal,
				[]any{nil, "2026-10-28T00:00:00Z"}[rng.Intn(2)], []any{nil, "2026-10-29T00:00:00Z"}[rng.Intn(2)], []any{nil, "2026-10-30T00:00:00Z"}[rng.Intn(2)])
			require.NoError(t, err)
		}
		if board != "empty" {
			// a priority that is none of the four (the table's CHECK is the backstop, so it is written with the check switched off): the old ORDER BY gave it NULL, which sorts first
			_, err := s.db.ExecContext(ctx, `PRAGMA ignore_check_constraints = ON`)
			require.NoError(t, err)
			for i, p := range []string{"urgent", "", "URGENT"} {
				_, err := s.db.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, priority, created_by, created_at) VALUES (?, ?, 'pending', ?, 'Orch', '2026-10-01T00:00:00Z')`, board, fmt.Sprintf("odd priority %d", i), p)
				require.NoError(t, err)
			}
			_, err = s.db.ExecContext(ctx, `PRAGMA ignore_check_constraints = OFF`)
			require.NoError(t, err)
		}
		want, err := oldListOpenTaskStates(ctx, s, board)
		require.NoError(t, err)
		got, err := s.ListOpenTaskStates(ctx, board)
		require.NoError(t, err)
		require.Equal(t, len(want), len(got), board)
		for i := range want {
			assert.Equal(t, want[i], got[i], "%s position %d", board, i)
		}
		if len(got) > 0 {
			nonEmpty++
			// the order itself: priority (critical first), then id
			rank := map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3} // a priority that is none of them is rank -1: first
			rankOf := func(p string) int {
				if r, ok := rank[p]; ok {
					return r
				}
				return -1
			}
			for i := 1; i < len(got); i++ {
				a, b := rankOf(got[i-1].Priority), rankOf(got[i].Priority)
				assert.True(t, a < b || (a == b && got[i-1].ID < got[i].ID), "%s position %d: %v then %v", board, i, got[i-1], got[i])
			}
		}
	}
	assert.Equal(t, 2, nonEmpty)
}

// The three odd priorities really are on the board and first (so the test above cannot pass without them).
func TestListOpenTaskStatesPutsAnUnknownPriorityFirst(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.db.ExecContext(ctx, `PRAGMA ignore_check_constraints = ON`)
	require.NoError(t, err)
	for _, row := range []struct{ prio string }{{"low"}, {"urgent"}, {"critical"}, {""}, {"high"}} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, priority, created_by, created_at) VALUES ('b', 't', 'pending', ?, 'Orch', '2026-10-01T00:00:00Z')`, row.prio)
		require.NoError(t, err)
	}
	_, err = s.db.ExecContext(ctx, `PRAGMA ignore_check_constraints = OFF`)
	require.NoError(t, err)
	got, err := s.ListOpenTaskStates(ctx, "b")
	require.NoError(t, err)
	var order []string
	for _, t := range got {
		order = append(order, t.Priority)
	}
	assert.Equal(t, []string{"urgent", "", "critical", "high", "low"}, order, "unknown priorities first (the old CASE gave NULL), in id order, then critical, high, low")
	want, err := oldListOpenTaskStates(ctx, s, "b")
	require.NoError(t, err)
	assert.Equal(t, want, got)
}
