package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17948: when one reviewer rejects a round, the other reviewers' open review tasks for it are closed (skipped, with the reason) so they are not offered; a resubmission opens them again for the next round.
func TestARejectionClosesTheOtherReviewersOpenReviewTasksAndAResubmitReopensThem(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	_, err := rt.s.ClaimTask(rt.ctx, "team", "QA", rt.review["QA"].ID)
	require.NoError(t, err)

	_, err = rt.s.RejectReview(rt.ctx, "team", rt.parent.ID, "Security", "no: it leaks", 1)
	require.NoError(t, err)

	own := rt.get(rt.review["Security"].ID)
	assert.Equal(t, "completed", own.Status, "the rejecting reviewer's own task is done")
	other := rt.get(rt.review["QA"].ID)
	assert.Equal(t, "skipped", other.Status, "the other reviewer's open task is closed, claimed or not")
	require.NotNil(t, other.CompletionMessage)
	assert.Contains(t, *other.CompletionMessage, "rejected by Security")
	assert.Contains(t, *other.CompletionMessage, "no longer needed")
	// the other reviewer's slot is free: nothing of theirs is in progress
	next, err := rt.s.CreateTask(rt.ctx, "team", "Next", "", "low", "Lead", "QA")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "QA", next.ID)
	require.NoError(t, err, "QA is free to take other work")

	// the author resubmits: both reviewers' review tasks are open again for round 2
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", rt.parent.ID)
	require.NoError(t, err)
	_, err = rt.s.SubmitCompletionReview(rt.ctx, "team", rt.parent.ID, "Worker", "fixed", "success", "done", nil)
	require.NoError(t, err)
	_, reopened, err := rt.s.HandToOrchestrator(rt.ctx, "team", rt.parent.ID, "Worker")
	require.NoError(t, err)
	require.NotNil(t, reopened)
	assert.Equal(t, "pending", rt.get(rt.review["QA"].ID).Status, "the next round offers it again")
	assert.Equal(t, "pending", rt.get(rt.review["Security"].ID).Status)
}

// A reviewer who had already approved keeps their finished task: only open ones are closed.
func TestARejectionLeavesAFinishedReviewTaskAlone(t *testing.T) {
	rt := newReviewTeam(t, "Security", "QA")
	_, err := rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "QA", "fine", 1)
	require.NoError(t, err)
	_, err = rt.s.RejectReview(rt.ctx, "team", rt.parent.ID, "Security", "no", 1)
	require.NoError(t, err)
	qa := rt.get(rt.review["QA"].ID)
	assert.Equal(t, "completed", qa.Status, "an approval already given stays a completed task")
}
