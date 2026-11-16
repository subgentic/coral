package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// AwayCounts is what happened on every board of this computer since a time (#17537, "While you were away"): tasks completed (not review tasks) and goals closed as done. Counts only.
func TestAwayCountsTasksDoneAndGoalsDoneSinceATime(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	done := func(project, title string) *Task {
		t.Helper()
		_, err := s.Subscribe(ctx, project, "worker", "Developer", "sess-"+project, nil, "all")
		require.NoError(t, err)
		task, err := s.CreateTask(ctx, project, title, "", "medium", "lead", "worker")
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, project, "worker", task.ID)
		require.NoError(t, err)
		_, err = s.CompleteTask(ctx, project, task.ID, "worker", nil)
		require.NoError(t, err)
		return task
	}
	old := done("alpha", "Finished long ago")
	done("alpha", "Finished now")
	done("beta", "Finished now on another board")
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET completed_at = ? WHERE id = ? AND board_id = 'alpha'`, time.Now().Add(-3*time.Hour).UTC().Format(time.RFC3339), old.ID)
	require.NoError(t, err)

	g, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Ship it", Outcome: "shipped", DoneWhen: "it is"})
	require.NoError(t, err)
	_, _, err = s.CloseGoal(ctx, "alpha", g.ID, "done", "done")
	require.NoError(t, err)
	d, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Dropped", Outcome: "x", DoneWhen: "y"})
	require.NoError(t, err)
	_, _, err = s.CloseGoal(ctx, "alpha", d.ID, "no longer needed", "dropped")
	require.NoError(t, err)

	got, err := s.AwayCounts(ctx, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.Equal(t, 2, got.TasksDone, "two tasks finished in the last hour, on two boards; the one from three hours ago is not counted")
	assert.Equal(t, 1, got.GoalsDone, "a goal closed as done counts, a dropped one does not")

	none, err := s.AwayCounts(ctx, time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, Away{}, none, "nothing since a time in the future")
}
