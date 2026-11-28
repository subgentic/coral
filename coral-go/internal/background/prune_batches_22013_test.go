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

// #22013: the hourly prunes delete in short batches with a pause between, so the database's one writer is never held behind one long delete.

// slowestWrite runs write until stop closes and answers the longest one took.
func slowestWrite(stop <-chan struct{}, write func()) (worst time.Duration, n int) {
	for {
		select {
		case <-stop:
			return worst, n
		default:
		}
		t0 := time.Now()
		write()
		if d := time.Since(t0); d > worst {
			worst = d
		}
		n++
		time.Sleep(2 * time.Millisecond)
	}
}

func TestPruningALargeHourlyBacklogNeverHoldsAWriteOverASecond(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()
	_, err := db.Exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 150000)
		INSERT INTO call_metrics_hourly(hour, call_type, operation, agent_name, calls) SELECT '2020-01-01T00', 'api', 'op', 'a' || i, 1 FROM c`)
	require.NoError(t, err)
	j := NewCallMetricsRetention(db)
	j.BatchSize, j.Pause = 2000, 5*time.Millisecond

	stop := make(chan struct{})
	res := make(chan time.Duration, 1)
	go func() {
		worst, _ := slowestWrite(stop, func() {
			_, _ = db.Exec(`INSERT INTO call_metrics(call_type, operation, method, created_at) VALUES ('api', '/x', 'GET', ?)`, time.Now().UTC().Format(time.RFC3339Nano))
		})
		res <- worst
	}()
	j.RunOnce(ctx)
	close(stop)
	worst := <-res
	var left int
	require.NoError(t, db.Get(&left, `SELECT COUNT(*) FROM call_metrics_hourly`))
	assert.Zero(t, left, "every expired hourly row went")
	assert.Less(t, worst, time.Second, "a write was never held over a second while the backlog was pruned")
}

func TestPruningGoalEventsIsBatchedAndKeepsTheNewestOfEachBoard(t *testing.T) {
	ctx := context.Background()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	for _, team := range []string{"alpha", "beta"} {
		g, err := bs.CreateGoal(ctx, team, board.GoalInput{Title: "Ship", CreatedBy: "Operator"})
		require.NoError(t, err)
		for i := 0; i < 30; i++ {
			title := "Ship " + string(rune('a'+i%26)) + string(rune('a'+i/26))
			_, err := bs.UpdateGoal(ctx, team, g.ID, board.GoalUpdate{Title: &title})
			require.NoError(t, err)
		}
	}
	count := func(team string) int {
		win, err := bs.GoalEventsWindow(ctx, []string{team}, 1000)
		require.NoError(t, err)
		return len(win[team])
	}
	require.Greater(t, count("alpha"), 5)
	n, err := bs.PruneGoalEventsBatch(ctx, 5, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 10, n, "one batch deletes at most its size")
	j := NewGoalEventsPrune(bs)
	j.Keep, j.BatchSize, j.Pause = 5, 7, time.Millisecond
	j.RunOnce(ctx)
	assert.Equal(t, 5, count("alpha"), "the newest five of each board stay")
	assert.Equal(t, 5, count("beta"))
	_, err = bs.PruneGoalEventsBatch(ctx, 5, 0)
	assert.Error(t, err)
}
