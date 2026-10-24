package board

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7292: GoalPage carries no_goal_open, how many of the board's open tasks serve no goal.
func TestGoalPageCountsTheOpenTasksThatServeNoGoal(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	noGoal := func(board string) int {
		t.Helper()
		page, err := s.GoalPage(ctx, board, GoalListQuery{})
		require.NoError(t, err)
		require.NotNil(t, page.NoGoalOpen, "the per-board read always carries the count")
		return *page.NoGoalOpen
	}
	assert.Equal(t, 0, noGoal("team"), "a board with nothing reads 0")

	g := newGoal(t, s, "team", "Ship")
	mk := func(board, title, status string, goal *int64) int64 {
		t.Helper()
		task, err := s.CreateTask(ctx, board, title, "", "medium", "Lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ? WHERE id = ?`, status, task.ID)
		require.NoError(t, err)
		if goal != nil {
			require.NoError(t, s.SetTaskGoal(ctx, board, task.ID, goal))
		}
		return task.ID
	}
	// every open state counts when there is no goal
	for _, st := range []string{"pending", "in_progress", "blocked", "draft", "review_pending"} {
		mk("team", "open "+st, st, nil)
	}
	assert.Equal(t, 5, noGoal("team"))
	// finished tasks do not, a task with a goal does not, another board's task does not
	mk("team", "completed", "completed", nil)
	mk("team", "skipped", "skipped", nil)
	linked := mk("team", "linked", "pending", &g.ID)
	mk("other", "elsewhere", "pending", nil)
	assert.Equal(t, 5, noGoal("team"))
	assert.Equal(t, 1, noGoal("other"))

	// linking a task to a goal takes it out of the count; unlinking brings it back
	first := mk("team", "to link", "pending", nil)
	assert.Equal(t, 6, noGoal("team"))
	require.NoError(t, s.SetTaskGoal(ctx, "team", first, &g.ID))
	assert.Equal(t, 5, noGoal("team"))
	require.NoError(t, s.SetTaskGoal(ctx, "team", linked, nil))
	assert.Equal(t, 6, noGoal("team"))
	// closing a goal leaves its tasks linked to it: they still serve a goal as far as this count goes
	_, _, err := s.CloseGoal(ctx, "team", g.ID, "done", "")
	require.NoError(t, err)
	assert.Equal(t, 6, noGoal("team"), "a task of a closed goal keeps its link and is not counted")
}

// The same number on every page of a listing and under every state filter, and the key is on an empty list too.
func TestGoalPageNoGoalOpenIsOnEveryPage(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		newGoal(t, s, "team", "goal "+string(rune('a'+i)))
	}
	for i := 0; i < 4; i++ {
		_, err := s.CreateTask(ctx, "team", "loose "+string(rune('a'+i)), "", "medium", "Lead")
		require.NoError(t, err)
	}
	first, err := s.GoalPage(ctx, "team", GoalListQuery{Limit: 2})
	require.NoError(t, err)
	require.NotEmpty(t, first.NextCursor)
	second, err := s.GoalPage(ctx, "team", GoalListQuery{Limit: 2, Cursor: first.NextCursor})
	require.NoError(t, err)
	require.NotNil(t, first.NoGoalOpen)
	require.NotNil(t, second.NoGoalOpen)
	assert.Equal(t, 4, *first.NoGoalOpen)
	assert.Equal(t, 4, *second.NoGoalOpen, "the last page carries it too")
	closed, err := s.GoalPage(ctx, "team", GoalListQuery{States: []string{GoalDone, GoalDropped}})
	require.NoError(t, err)
	assert.Empty(t, closed.Goals)
	require.NotNil(t, closed.NoGoalOpen)
	assert.Equal(t, 4, *closed.NoGoalOpen, "a state filter that matches no goal still carries it")
	raw, err := json.Marshal(closed)
	require.NoError(t, err)
	assert.Contains(t, string(raw), `"no_goal_open":4`)
	assert.Contains(t, string(raw), `"goals":[]`)
}

// One indexed count: the plan walks idx_board_tasks_board_status, with no table scan and no sort.
func TestNoGoalOpenCountUsesAnIndex(t *testing.T) {
	s := testStore(t)
	marks := strings.TrimSuffix(strings.Repeat("?,", len(openTaskStatuses)), ",")
	args := []any{"team"}
	for _, st := range openTaskStatuses {
		args = append(args, st)
	}
	rows, err := s.db.QueryxContext(context.Background(), `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND status IN (`+marks+`) AND goal_id IS NULL`, args...)
	require.NoError(t, err)
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &notused, &detail))
		plan = append(plan, detail)
	}
	joined := strings.Join(plan, "\n")
	assert.Contains(t, joined, "idx_board_tasks_board_status", joined)
	assert.NotContains(t, joined, "SCAN board_tasks\n", joined)
}

// The machine-wide read has no such count: AllGoalsPage leaves no_goal_open out (a 0 there would be wrong, not absent).
func TestAllGoalsPageHasNoNoGoalOpen(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	newGoal(t, s, "team", "Ship")
	_, err := s.CreateTask(ctx, "team", "loose", "", "medium", "Lead")
	require.NoError(t, err)
	page, err := s.AllGoalsPage(ctx, AllGoalsQuery{})
	require.NoError(t, err)
	assert.Nil(t, page.NoGoalOpen)
	raw, err := json.Marshal(page)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "no_goal_open")
	assert.Contains(t, string(raw), `"goals":[`)
}
