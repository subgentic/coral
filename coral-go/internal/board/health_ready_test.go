package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Two lines of the orchestrator's check (#8975): a goal whose every task is done, and open tasks with no goal or no assignee.

func readyStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	_, err = s.Subscribe(ctx, "team", "Lead", "Orchestrator", "lead-session", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "team", "Dev", "Developer", "dev-session", nil, "all")
	require.NoError(t, err)
	return s
}

func readyGoal(t *testing.T, s *Store, title string) int64 {
	t.Helper()
	g, err := s.CreateGoal(context.Background(), "team", GoalInput{Title: title, Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	return g.ID
}

// goalTask makes a task of the goal assigned to Dev, and finishes it when done is set.
func goalTask(t *testing.T, s *Store, goal int64, done bool) int64 {
	t.Helper()
	ctx := context.Background()
	task, err := s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal}, "Dev")
	require.NoError(t, err)
	if done {
		claimed, err := s.ClaimTask(ctx, "team", "Dev", task.ID)
		require.NoError(t, err)
		_, err = s.CompleteTask(ctx, "team", claimed.ID, "Dev", nil)
		require.NoError(t, err)
	}
	return task.ID
}

func readyIDs(g []GoalReady) []int64 {
	out := []int64{}
	for _, r := range g {
		out = append(out, r.ID)
	}
	return out
}

func TestAGoalWhoseEveryTaskIsDoneIsReadyToClose(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	future, past := time.Now().Add(time.Hour), time.Now().Add(-time.Hour)
	allDone := readyGoal(t, s, "all done")
	goalTask(t, s, allDone, true)
	goalTask(t, s, allDone, true)
	open := readyGoal(t, s, "one still open")
	goalTask(t, s, open, true)
	goalTask(t, s, open, false)
	empty := readyGoal(t, s, "no tasks")

	got, err := s.GoalsReadyToClose(ctx, "team", future)
	require.NoError(t, err)
	assert.Equal(t, []int64{allDone}, readyIDs(got), "a goal with an open task, and a goal with no task, are not ready")
	assert.Equal(t, 2, got[0].Tasks)
	assert.WithinDuration(t, time.Now(), got[0].Done, time.Minute, "the last task's completion time")
	_ = empty

	none, err := s.GoalsReadyToClose(ctx, "team", past)
	require.NoError(t, err)
	assert.Empty(t, none, "done after the cut-off: the wait has not passed")
}

func TestACancelledTaskDoesNotHoldAGoalOpenButOnlyCancelledTasksAreNotReady(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	future := time.Now().Add(time.Hour)
	mixed := readyGoal(t, s, "one done one cancelled")
	goalTask(t, s, mixed, true)
	cancelled := goalTask(t, s, mixed, false)
	_, err := s.CancelTask(ctx, "team", cancelled, "Lead", nil)
	require.NoError(t, err)
	onlyCancelled := readyGoal(t, s, "only cancelled")
	c2 := goalTask(t, s, onlyCancelled, false)
	_, err = s.CancelTask(ctx, "team", c2, "Lead", nil)
	require.NoError(t, err)

	got, err := s.GoalsReadyToClose(ctx, "team", future)
	require.NoError(t, err)
	assert.Equal(t, []int64{mixed}, readyIDs(got))
	assert.Equal(t, 2, got[0].Tasks, "the cancelled task counts as one of its tasks")
}

func TestAClosedGoalAndAnotherBoardsGoalAreNotReady(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	future := time.Now().Add(time.Hour)
	closed := readyGoal(t, s, "closed")
	goalTask(t, s, closed, true)
	_, _, err := s.CloseGoal(ctx, "team", closed, "met", GoalDone)
	require.NoError(t, err)
	dropped := readyGoal(t, s, "dropped")
	goalTask(t, s, dropped, true)
	_, _, err = s.CloseGoal(ctx, "team", dropped, "no", GoalDropped)
	require.NoError(t, err)
	got, err := s.GoalsReadyToClose(ctx, "team", future)
	require.NoError(t, err)
	assert.Empty(t, got, "done and dropped goals are closed already")
	other, err := s.GoalsReadyToClose(ctx, "other-board", future)
	require.NoError(t, err)
	assert.Empty(t, other)
}

func TestOpenTasksWithNoGoalOrNoAssigneeAreListedByNumber(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	future, past := time.Now().Add(time.Hour), time.Now().Add(-time.Hour)
	goal := readyGoal(t, s, "g")
	owned := goalTask(t, s, goal, false) // a goal and an assignee: fine
	noGoal, err := s.CreateTaskWithOpts(ctx, "team", "loose", "", "medium", "Lead", nil, "Dev")
	require.NoError(t, err)
	noAssignee, err := s.CreateTaskWithOpts(ctx, "team", "unassigned", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal})
	require.NoError(t, err)
	neither, err := s.CreateTaskWithOpts(ctx, "team", "both missing", "", "medium", "Lead", nil)
	require.NoError(t, err)
	finished, err := s.CreateTaskWithOpts(ctx, "team", "finished loose", "", "medium", "Lead", nil, "Dev")
	require.NoError(t, err)
	claimed, err := s.ClaimTask(ctx, "team", "Dev", finished.ID)
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "team", claimed.ID, "Dev", nil)
	require.NoError(t, err)

	got, err := s.UnownedOpenTasks(ctx, "team", future)
	require.NoError(t, err)
	byID := map[int64]UnownedTask{}
	for _, u := range got {
		byID[u.ID] = u
	}
	assert.Len(t, byID, 3, "the owned task and the finished one are not listed")
	assert.NotContains(t, byID, owned)
	assert.NotContains(t, byID, finished.ID)
	assert.Equal(t, UnownedTask{ID: noGoal.ID, NoGoal: true}, byID[noGoal.ID])
	assert.Equal(t, UnownedTask{ID: noAssignee.ID, NoAssignee: true}, byID[noAssignee.ID])
	assert.Equal(t, UnownedTask{ID: neither.ID, NoGoal: true, NoAssignee: true}, byID[neither.ID])

	young, err := s.UnownedOpenTasks(ctx, "team", past)
	require.NoError(t, err)
	assert.Empty(t, young, "created after the cut-off: not older than the wait yet")
	other, err := s.UnownedOpenTasks(ctx, "other-board", future)
	require.NoError(t, err)
	assert.Empty(t, other)
}

func TestTheNewWaitChecksHaveDefaultsAndLimits(t *testing.T) {
	d := DefaultHealthSettings().Clamp()
	assert.Equal(t, HealthWaitCheck{On: true, WaitMin: 30}, d.GoalsReady, "on by default, 30 minutes")
	assert.Equal(t, HealthWaitCheck{On: true, WaitMin: 15}, d.UnownedTasks, "on by default, 15 minutes")
	assert.False(t, DefaultHealthSettings().Landing.On, "the landing alert stays off by default")
	zero := HealthSettings{}.Clamp()
	assert.Equal(t, 30, zero.GoalsReady.WaitMin, "a body that carries no wait: the default wait")
	assert.Equal(t, 15, zero.UnownedTasks.WaitMin)
	clamped := HealthSettings{GoalsReady: HealthWaitCheck{On: true, WaitMin: 1, Nudge: " Lead "}, UnownedTasks: HealthWaitCheck{WaitMin: 99999}}.Clamp()
	assert.Equal(t, HealthWaitCheck{On: true, WaitMin: 5, Nudge: "Lead"}, clamped.GoalsReady)
	assert.Equal(t, 10080, clamped.UnownedTasks.WaitMin)
	assert.Empty(t, HealthWaitCheck{WaitMin: 5}.Problem("goals_ready"))
	assert.Empty(t, HealthWaitCheck{}.Problem("goals_ready"), "a body that does not carry the wait is the default")
	assert.Contains(t, HealthWaitCheck{WaitMin: 4}.Problem("goals_ready"), "goals_ready.wait_min")
	assert.Contains(t, HealthWaitCheck{WaitMin: 10081}.Problem("unowned_tasks"), "unowned_tasks.wait_min")
	assert.Contains(t, HealthWaitCheck{WaitMin: -3}.Problem("unowned_tasks"), "outside 5 to 10080")
}

func TestAnEmptyOrZeroGoalAndAnEmptyAssigneeCountAsMissing(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	future := time.Now().Add(time.Hour)
	goal := readyGoal(t, s, "g")
	zeroGoal, err := s.CreateTaskWithOpts(ctx, "team", "zero goal", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal}, "Dev")
	require.NoError(t, err)
	blankAssignee, err := s.CreateTaskWithOpts(ctx, "team", "blank assignee", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal}, "Dev")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = 0 WHERE id = ?`, zeroGoal.ID)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET assigned_to = '' WHERE id = ?`, blankAssignee.ID)
	require.NoError(t, err)
	got, err := s.UnownedOpenTasks(ctx, "team", future)
	require.NoError(t, err)
	byID := map[int64]UnownedTask{}
	for _, u := range got {
		byID[u.ID] = u
	}
	assert.Equal(t, UnownedTask{ID: zeroGoal.ID, NoGoal: true}, byID[zeroGoal.ID], "a goal id of 0 is no goal")
	assert.Equal(t, UnownedTask{ID: blankAssignee.ID, NoAssignee: true}, byID[blankAssignee.ID], "an empty assignee is no assignee")
}

func TestReviewTasksAreNotUnownedWork(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	// the reviews of a task in review: assigned to their reviewers, belonging to no goal
	for _, who := range []string{"Security", "QA"} {
		_, err := s.Subscribe(ctx, "team", who, who, who+"-session", nil, "mentions")
		require.NoError(t, err)
	}
	parent, err := s.CreateTask(ctx, "team", "Build it", "", "critical", "Lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", parent.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReview(ctx, "team", parent.ID, "Dev", "built", "success", "done", nil)
	require.NoError(t, err)
	_, _, err = s.HandToOrchestrator(ctx, "team", parent.ID, "Dev")
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "team", parent.ID, "Lead", []string{"Security", "QA"})
	require.NoError(t, err)
	require.Len(t, reviews, 2)
	for _, r := range reviews {
		task, err := s.GetTask(ctx, "team", r.ID)
		require.NoError(t, err)
		require.Equal(t, "pending", task.Status)
	}
	got, err := s.UnownedOpenTasks(ctx, "team", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Empty(t, got, "a review task is not work to give a goal: %v", got)
	ready, err := s.GoalsReadyToClose(ctx, "team", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Empty(t, ready)
}

// A review task is not work: if one carries the goal (the review of a task of this goal), the goal is still ready to close when its work is done, review pending or not (#8975, review pin).
func TestAGoalWithAReviewTaskIsStillReadyToClose(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	goal := readyGoal(t, s, "g")
	work := goalTask(t, s, goal, true)
	review, err := s.CreateTaskWithOpts(ctx, "team", "Review #1: work", "", "medium", "Coral Task Queue",
		&CreateTaskOpts{GoalID: &goal, Workflow: TaskWorkflow{ReviewOf: work, ReviewRound: 1}, reviewTask: true}, "Dev")
	require.NoError(t, err)
	got, err := s.GetTask(ctx, "team", review.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", got.Status, "the review is open")
	require.NotNil(t, got.GoalID, "the review carries the goal, or this pins nothing")
	ready, err := s.GoalsReadyToClose(ctx, "team", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, []int64{goal}, readyIDs(ready), "an open review does not hold the goal open")
	assert.Equal(t, 1, ready[0].Tasks, "and a review is not counted as one of its tasks")
}

// A draft is not yet anyone's to own: with no goal and no assignee it is still not listed (#8975, review pin).
func TestADraftTaskIsNeverUnowned(t *testing.T) {
	s, ctx := readyStore(t), context.Background()
	draft, err := s.CreateTaskWithOpts(ctx, "team", "idea", "", "medium", "Lead", &CreateTaskOpts{Draft: true})
	require.NoError(t, err)
	got, err := s.GetTask(ctx, "team", draft.ID)
	require.NoError(t, err)
	require.Equal(t, "draft", got.Status)
	unowned, err := s.UnownedOpenTasks(ctx, "team", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Empty(t, unowned, "a draft with no goal and no assignee is not unowned work")
}
