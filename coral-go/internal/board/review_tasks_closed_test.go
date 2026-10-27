package board

import (
	"context"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8875: a task completed by hand, or cancelled, while it is in review ends its reviewers' open review tasks, with a note (#8865 stayed pending and critical after #8838 was completed).
type reviewTeam struct {
	t      *testing.T
	s      *Store
	ctx    context.Context
	parent *Task
	review map[string]*Task // by reviewer
}

func newReviewTeam(t *testing.T, reviewers ...string) *reviewTeam {
	t.Helper()
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	_, err = s.Subscribe(ctx, "team", "Lead", "Orchestrator", "lead-session", nil, "all")
	require.NoError(t, err)
	for _, who := range append([]string{"Worker"}, reviewers...) {
		_, err = s.Subscribe(ctx, "team", who, who, who+"-session", nil, "mentions")
		require.NoError(t, err)
	}
	parent, err := s.CreateTask(ctx, "team", "Build it", "", "critical", "Lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", parent.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReview(ctx, "team", parent.ID, "Worker", "built", "success", "done", nil)
	require.NoError(t, err)
	_, _, err = s.HandToOrchestrator(ctx, "team", parent.ID, "Worker")
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "team", parent.ID, "Lead", reviewers)
	require.NoError(t, err)
	rt := &reviewTeam{t: t, s: s, ctx: ctx, parent: parent, review: map[string]*Task{}}
	for _, r := range reviews {
		rt.review[*r.AssignedTo] = r
	}
	require.Len(t, rt.review, len(reviewers))
	return rt
}

func (rt *reviewTeam) get(id int64) *Task {
	rt.t.Helper()
	task, err := rt.s.GetTask(rt.ctx, "team", id)
	require.NoError(rt.t, err)
	return task
}

func (rt *reviewTeam) assertClosed(reviewer, how, by string) {
	rt.t.Helper()
	got := rt.get(rt.review[reviewer].ID)
	assert.Equal(rt.t, "skipped", got.Status, reviewer)
	require.NotNil(rt.t, got.CompletionMessage, reviewer)
	assert.Contains(rt.t, *got.CompletionMessage, how, reviewer)
	assert.Contains(rt.t, *got.CompletionMessage, "#"+itoa(rt.parent.ID), reviewer)
	assert.Contains(rt.t, *got.CompletionMessage, by, reviewer)
	assert.Contains(rt.t, *got.CompletionMessage, "no longer needed", reviewer)
	require.NotNil(rt.t, got.CompletedBy, reviewer)
	assert.Equal(rt.t, by, *got.CompletedBy, reviewer)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestCompletingATaskInReviewByHandClosesItsReviewTasks(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	require.Equal(t, "review_pending", rt.get(rt.parent.ID).Status)
	for _, r := range rt.review {
		require.Equal(t, "pending", rt.get(r.ID).Status)
	}
	msg := "done by hand"
	done, err := rt.s.CompleteTaskWithArtifacts(rt.ctx, "team", rt.parent.ID, "Lead", &msg, "success", nil)
	require.NoError(t, err)
	assert.Equal(t, "completed", done.Status)
	rt.assertClosed("Security", "completed", "Lead")
	rt.assertClosed("QA", "completed", "Lead")
}

func TestCancellingATaskInReviewClosesItsReviewTasks(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	msg := "not needed"
	got, err := rt.s.CancelTask(rt.ctx, "team", rt.parent.ID, "Lead", &msg)
	require.NoError(t, err)
	assert.Equal(t, "skipped", got.Status)
	rt.assertClosed("Security", "cancelled", "Lead")
	rt.assertClosed("QA", "cancelled", "Lead")
}

func TestAReviewTaskAReviewerHasClaimedIsClosedToo(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	_, err := rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", rt.get(rt.review["Security"].ID).Status)
	_, err = rt.s.CancelTask(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	rt.assertClosed("Security", "cancelled", "Lead")
	rt.assertClosed("QA", "cancelled", "Lead")
	// the reviewer's slot is free again: nothing of theirs is in progress, so they can claim other work
	other, err := rt.s.CreateTask(rt.ctx, "team", "Next", "", "low", "Lead", "Security")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Security", other.ID)
	require.NoError(t, err)
}

func TestAVerdictAlreadyGivenIsLeftAsItIsWhenTheTaskIsCompletedByHand(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	_, err := rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "fine", 1)
	require.NoError(t, err)
	approved := rt.get(rt.review["Security"].ID)
	require.Equal(t, "completed", approved.Status)
	_, err = rt.s.CompleteTaskWithArtifacts(rt.ctx, "team", rt.parent.ID, "Lead", nil, "success", nil)
	require.NoError(t, err)
	assert.Equal(t, "completed", rt.get(rt.review["Security"].ID).Status, "the approved review stays completed")
	rt.assertClosed("QA", "completed", "Lead")
}

func TestApprovalsThatCompleteTheTaskLeaveTheirReviewTasksCompleted(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	for _, who := range []string{"Security", "QA"} {
		_, err := rt.s.ClaimTask(rt.ctx, "team", who, rt.review[who].ID)
		require.NoError(t, err)
		_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, who, "ok", 1)
		require.NoError(t, err)
	}
	_, err := rt.s.CompleteApprovedReview(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	assert.Equal(t, "completed", rt.get(rt.parent.ID).Status)
	for _, who := range []string{"Security", "QA"} {
		assert.Equal(t, "completed", rt.get(rt.review[who].ID).Status, who)
	}
}

func TestAnotherTasksReviewTasksAreNotTouched(t *testing.T) {
	rt := newReviewTeam(t, "Security")
	other, err := rt.s.CreateTask(rt.ctx, "team", "Unrelated", "", "low", "Lead", "Security")
	require.NoError(t, err)
	_, err = rt.s.CancelTask(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	assert.Equal(t, "pending", rt.get(other.ID).Status)
}

// #8875: a review given to a reviewer who is at work waits in their queue, and is the next thing offered when their own task ends.
func TestAReviewForABusyReviewerIsOfferedWhenTheirTaskEnds(t *testing.T) {
	rt := newReviewTeam(t, "Security")
	own, err := rt.s.CreateTask(rt.ctx, "team", "Their own work", "", "low", "Lead", "Security")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Security", own.ID)
	require.NoError(t, err)
	busy, err := rt.s.HasActiveTaskForAssignee(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	assert.True(t, busy, "at work: the review does not interrupt")
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.Error(t, err, "the review cannot be claimed over the active task")

	_, err = rt.s.CompleteTask(rt.ctx, "team", own.ID, "Security", nil)
	require.NoError(t, err)
	busy, err = rt.s.HasActiveTaskForAssignee(rt.ctx, "team", "Security", 0)
	require.NoError(t, err)
	assert.False(t, busy)
	next := rt.s.NextPendingTaskForSubscriber(rt.ctx, "team", "Security")
	require.NotNil(t, next, "the review is offered next")
	assert.Equal(t, rt.review["Security"].ID, next.ID)
}

// A workflow that names another board's task as a review task (planted here: Coral never writes one) closes nothing of that board: the update is scoped to the finished task's own board.
func TestClosingReviewTasksStaysOnTheTasksOwnBoard(t *testing.T) {
	rt := newReviewTeam(t, "Security")
	_, err := rt.s.Subscribe(rt.ctx, "elsewhere", "Security", "Security", "sec-session-2", nil, "mentions")
	require.NoError(t, err)
	foreign, err := rt.s.CreateTask(rt.ctx, "elsewhere", "Another board's work", "", "high", "Security", "Security")
	require.NoError(t, err)
	require.Equal(t, "pending", rt.get2("elsewhere", foreign.ID).Status)

	w, err := loadWorkflow(rt.ctx, rt.s.db, rt.parent.ID)
	require.NoError(t, err)
	require.NotEmpty(t, w.ReviewRounds)
	w.ReviewRounds[0].Reviewers = append(w.ReviewRounds[0].Reviewers, ReviewerState{Reviewer: "Security", ReviewTaskID: foreign.ID, State: "pending"})
	require.NoError(t, saveWorkflow(rt.ctx, rt.s.db, rt.parent.ID, w))

	_, err = rt.s.CancelTask(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	rt.assertClosed("Security", "cancelled", "Lead") // its own review task is closed...
	other := rt.get2("elsewhere", foreign.ID)
	assert.Equal(t, "pending", other.Status, "...the other board's task, named in the workflow, is not")
	assert.Nil(t, other.CompletionMessage)
}

func (rt *reviewTeam) get2(project string, id int64) *Task {
	rt.t.Helper()
	task, err := rt.s.GetTask(rt.ctx, project, id)
	require.NoError(rt.t, err)
	return task
}
