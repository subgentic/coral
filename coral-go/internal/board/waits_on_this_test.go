package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// What waits on an Inbox item, from the board data of every board (#11455).
func waitsStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s
}

func TestWaitsOnATaskCountsItsDependentsOnEveryBoardAndTheGoalItCloses(t *testing.T) {
	ctx := context.Background()
	s := waitsStore(t)
	g, err := s.CreateGoal(ctx, "team", GoalInput{Title: "Ship it", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	up, err := s.CreateTaskWithOpts(ctx, "team", "Review me", "", "medium", "lead", &CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	low, err := s.CreateTaskWithOpts(ctx, "team", "Low waiter", "", "low", "lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: up.ID, BoardID: "team"}}})
	require.NoError(t, err)
	high, err := s.CreateTaskWithOpts(ctx, "team", "High waiter", "", "high", "lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: up.ID, BoardID: "team"}}})
	require.NoError(t, err)
	other, err := s.CreateTaskWithOpts(ctx, "elsewhere", "Waiter on another board", "", "critical", "lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: up.ID, BoardID: "team"}}})
	require.NoError(t, err, "a task of another board may wait on this one")
	_, _ = low, high

	got, err := s.WaitsOnTasks(ctx, "team", []int64{up.ID})
	require.NoError(t, err)
	info, ok := got[up.ID]
	require.True(t, ok)
	require.Equal(t, 3, info.Count, "the two of this board and the one of the other")
	require.Equal(t, "Waiter on another board", info.TopTitle, "the highest priority first, whichever board it is on")
	require.Equal(t, "critical", info.Priority)
	require.Equal(t, "Ship it", info.ClosesGoal, "its task is the last open one of the goal")

	// a finished waiter no longer waits; a goal with another open task is not closed by this one
	_, err = s.ClaimTask(ctx, "elsewhere", "dev", other.ID)
	_ = err
	more, err := s.CreateTaskWithOpts(ctx, "team", "Another in the goal", "", "medium", "lead", &CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_ = more
	got, err = s.WaitsOnTasks(ctx, "team", []int64{up.ID})
	require.NoError(t, err)
	require.Equal(t, "", got[up.ID].ClosesGoal, "another open task of the goal: this one does not close it")

	lonely, err := s.CreateTaskWithOpts(ctx, "team", "Nobody waits", "", "medium", "lead", nil)
	require.NoError(t, err)
	got, err = s.WaitsOnTasks(ctx, "team", []int64{lonely.ID})
	require.NoError(t, err)
	_, ok = got[lonely.ID]
	require.False(t, ok, "no waiter and no goal: nothing is said")
}

func TestWaitsOnASessionIsItsInProgressTasksAndWhatWaitsOnThemMatchedBySubscriber(t *testing.T) {
	ctx := context.Background()
	s := waitsStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Developer", "claude-aaaa", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "team", "Dev Two", "Developer", "claude-bbbb", nil, "all") // a name that begins with the first one's
	require.NoError(t, err)
	mine, err := s.CreateTaskWithOpts(ctx, "team", "My task", "", "high", "lead", nil, "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", mine.ID)
	require.NoError(t, err)
	_, err = s.CreateTaskWithOpts(ctx, "team", "Waits on mine", "", "medium", "lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: mine.ID, BoardID: "team"}}})
	require.NoError(t, err)
	_, err = s.CreateTaskWithOpts(ctx, "elsewhere", "Waits on mine, on another board", "", "critical", "lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: mine.ID, BoardID: "team"}}})
	require.NoError(t, err)

	got, err := s.WaitsOnSessions(ctx, []WaitOwner{
		{Key: "dev", SessionName: "claude-aaaa", SessionID: "aaaa"},
		{Key: "devtwo", SessionName: "claude-bbbb", SessionID: "bbbb"},
		{Key: "nobody", SessionName: "claude-cccc", SessionID: "cccc"},
	})
	require.NoError(t, err)
	info, ok := got["dev"]
	require.True(t, ok)
	require.Equal(t, 3, info.Count, "its own task and the two that wait on it, one on another board")
	require.Equal(t, "Waits on mine, on another board", info.TopTitle)
	require.Equal(t, "critical", info.Priority)
	_, ok = got["devtwo"]
	require.False(t, ok, "another subscriber with a name that begins the same has nothing in progress")
	_, ok = got["nobody"]
	require.False(t, ok, "a session with no task in progress")
}
