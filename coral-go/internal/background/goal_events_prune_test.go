package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7355: the periodic job that prunes the goal events: a run keeps the newest Keep of each board, and Run does it on its schedule until its context ends.
func TestGoalEventsPruneKeepsTheNewestAndRunsOnItsSchedule(t *testing.T) {
	ctx := context.Background()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship", CreatedBy: "Operator"})
	require.NoError(t, err)
	for i := 0; i < 12; i++ {
		title := "Ship " + string(rune('a'+i))
		_, err := bs.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{Title: &title})
		require.NoError(t, err)
	}
	count := func() int {
		win, err := bs.GoalEventsWindow(ctx, []string{"team"}, 1000)
		require.NoError(t, err)
		return len(win["team"])
	}
	require.Equal(t, 13, count())

	j := NewGoalEventsPrune(bs)
	assert.Equal(t, GoalEventsKeep, j.Keep, "a thousand per board")
	assert.Zero(t, j.RunOnce(ctx), "under the limit nothing goes")
	j.Keep = 5
	assert.EqualValues(t, 8, j.RunOnce(ctx))
	assert.Equal(t, 5, count())

	// on its schedule: the first run after FirstRun, then every Interval, and it ends with its context
	j.Keep, j.FirstRun, j.Interval = 2, time.Millisecond, 5*time.Millisecond
	run, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- j.Run(run) }()
	require.Eventually(t, func() bool { return count() == 2 }, 5*time.Second, 5*time.Millisecond)
	stop()
	select {
	case err := <-done:
		assert.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("the job did not end with its context")
	}
}
