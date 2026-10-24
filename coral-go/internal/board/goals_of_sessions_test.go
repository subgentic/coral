package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7301: the goal of an agent's in-progress task, and the goal title on a task list.
func TestGoalsOfSessionsReadsTheInProgressTasksGoal(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Ship the beta")
	other := newGoal(t, s, "other", "Elsewhere")
	mk := func(board, title, status, session string, goal *int64) int64 {
		t.Helper()
		task, err := s.CreateTask(ctx, board, title, "", "medium", "Lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ?, session_id = NULLIF(?, ''), claimed_at = ? WHERE id = ?`, status, session, "2026-10-24T10:00:00Z", task.ID)
		require.NoError(t, err)
		if goal != nil {
			require.NoError(t, s.SetTaskGoal(ctx, board, task.ID, goal))
		}
		return task.ID
	}
	mk("team", "working", "in_progress", "sess-a", &g.ID)
	mk("team", "no goal", "in_progress", "sess-b", nil)
	mk("team", "queued", "pending", "sess-c", &g.ID)
	mk("team", "done", "completed", "sess-d", &g.ID)
	mk("other", "elsewhere", "in_progress", "sess-e", &other.ID)
	got, err := s.GoalsOfSessions(ctx, []string{"sess-a", "sess-b", "sess-c", "sess-d", "sess-e", "sess-none"})
	require.NoError(t, err)
	assert.Equal(t, GoalRef{ID: g.ID, Title: "Ship the beta", Board: "team"}, got["sess-a"])
	assert.NotContains(t, got, "sess-b", "an in-progress task with no goal has none")
	assert.NotContains(t, got, "sess-c", "a pending task is not what the agent is on")
	assert.NotContains(t, got, "sess-d", "a finished task is not either")
	assert.Equal(t, GoalRef{ID: other.ID, Title: "Elsewhere", Board: "other"}, got["sess-e"], "each board's goal is its own")
	assert.NotContains(t, got, "sess-none")

	// the newest claim wins when a session holds two in-progress tasks
	second := mk("team", "second", "in_progress", "sess-a", &g.ID)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = '2026-10-24T11:00:00Z' WHERE id = ?`, second)
	require.NoError(t, err)
	g2 := newGoal(t, s, "team", "The newer goal")
	require.NoError(t, s.SetTaskGoal(ctx, "team", second, &g2.ID))
	got, err = s.GoalsOfSessions(ctx, []string{"sess-a"})
	require.NoError(t, err)
	assert.Equal(t, "The newer goal", got["sess-a"].Title)

	// more sessions than one chunk
	many := make([]string, 1000)
	for i := range many {
		many[i] = "x-" + string(rune('a'+i%26)) + itoaGoal(i)
	}
	got, err = s.GoalsOfSessions(ctx, append(many, "sess-e"))
	require.NoError(t, err)
	assert.Contains(t, got, "sess-e", "a session past the first chunk is read too")
	none, err := s.GoalsOfSessions(ctx, nil)
	require.NoError(t, err)
	assert.Empty(t, none)
}

func itoaGoal(i int) string {
	b := []byte{}
	if i == 0 {
		return "0"
	}
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

func TestFillGoalTitlesNamesTheGoalsOfTheTasks(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Ship the beta")
	linked, err := s.CreateTask(ctx, "team", "linked", "", "medium", "Lead")
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", linked.ID, &g.ID))
	loose, err := s.CreateTask(ctx, "team", "loose", "", "medium", "Lead")
	require.NoError(t, err)
	tasks, err := s.ListTasks(ctx, "team")
	require.NoError(t, err)
	require.NoError(t, s.FillGoalTitles(ctx, tasks))
	titles := map[int64]string{}
	for _, tk := range tasks {
		titles[tk.ID] = tk.GoalTitle
	}
	assert.Equal(t, "Ship the beta", titles[linked.ID])
	assert.Empty(t, titles[loose.ID], "a task with no goal has no title")
	require.NoError(t, s.FillGoalTitles(ctx, nil), "an empty list is fine")
}
