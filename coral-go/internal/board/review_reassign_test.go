package board

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14866 (the Operator: "Coral doesn't allow reassigning a review task, we should fix that"): task reassign on a review task moves the review to another reviewer. The parent's round names the new
// one in the old one's place, the verdicts already given stay, and the refusals say why.

func reviewToReassign(t *testing.T) (s *Store, parent int64, qa, sec *Task) {
	t.Helper()
	s, ctx := perfStore(t)
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}, {"Sec", "Security Reviewer"}, {"Rev3", "Tech Lead"}} {
		_, err := s.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	task, err := s.CreateTask(ctx, "team", "the work", "body", "high", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", nil, nil, "")
	require.NoError(t, err)
	_, _, err = s.HandToOrchestrator(ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "team", task.ID, "lead", []string{"QA", "Sec"})
	require.NoError(t, err)
	require.Len(t, reviews, 2)
	return s, task.ID, reviews[0], reviews[1]
}

func roundReviewers(t *testing.T, s *Store, parent int64) map[string]ReviewerState {
	t.Helper()
	task, err := s.GetTask(t.Context(), "team", parent)
	require.NoError(t, err)
	rs := task.Workflow.ReviewRounds
	require.NotEmpty(t, rs)
	out := map[string]ReviewerState{}
	for _, r := range rs[len(rs)-1].Reviewers {
		out[r.Reviewer] = r
	}
	return out
}

func TestAReviewTaskMovesToAnotherReviewerAndKeepsTheOthersVerdicts(t *testing.T) {
	s, parent, qa, sec := reviewToReassign(t)
	ctx := t.Context()
	_, err := s.ApproveReview(ctx, "team", parent, "Sec", "fine", 0)
	require.NoError(t, err)

	moved, err := s.ReassignTask(ctx, "team", qa.ID, "Rev3")
	require.NoError(t, err)
	assert.Equal(t, qa.ID, moved.ID, "the same review task moves")
	require.NotNil(t, moved.AssignedTo)
	assert.Equal(t, "Rev3", *moved.AssignedTo)
	assert.Equal(t, "pending", moved.Status)

	got := roundReviewers(t, s, parent)
	assert.NotContains(t, got, "QA", "the old reviewer drops off the round")
	assert.Equal(t, "pending", got["Rev3"].State)
	assert.Equal(t, qa.ID, got["Rev3"].ReviewTaskID)
	assert.Equal(t, "approved", got["Sec"].State, "the approval so far is kept")
	assert.Equal(t, sec.ID, got["Sec"].ReviewTaskID)

	_, err = s.ApproveReview(ctx, "team", parent, "QA", "late", 0)
	require.Error(t, err, "the old reviewer has no open review any more")
	v, err := s.ApproveReview(ctx, "team", parent, "Rev3", "ok", 0)
	require.NoError(t, err)
	assert.True(t, v.Complete, "the new reviewer's approval completes the round with Sec's kept one")
}

func TestAReviewTaskIsNotMovedToTheAuthorADuplicateOrAFinishedReview(t *testing.T) {
	s, parent, qa, sec := reviewToReassign(t)
	ctx := t.Context()
	for name, to := range map[string]string{"the parent's author": "Dev", "someone already reviewing it": "Sec", "the same reviewer": "QA", "no one on the board": "Nobody", "no one named": ""} {
		_, err := s.ReassignTask(ctx, "team", qa.ID, to)
		require.Error(t, err, name)
		assert.NotContains(t, err.Error(), "a review task cannot be reassigned", "%s: the old blanket refusal is gone", name)
		assert.Equal(t, "pending", roundReviewers(t, s, parent)["QA"].State, name)
	}
	_, err := s.ApproveReview(ctx, "team", parent, "Sec", "fine", 0)
	require.NoError(t, err)
	_, err = s.ReassignTask(ctx, "team", sec.ID, "Rev3")
	require.Error(t, err, "a finished review is not moved")
	assert.True(t, errors.Is(err, ErrTaskReassignRefused), "a typed refusal the route answers 409: %v", err)
	assert.Equal(t, "approved", roundReviewers(t, s, parent)["Sec"].State)
}
