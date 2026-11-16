package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #18336: the author of a task in review sends a new revision: the same review tasks open the next round, each reviewer is pending again, and the earlier round's verdicts are history.
func TestTheAuthorSendsANewRevisionWhileTheTaskIsInReview(t *testing.T) {
	s, parent, qa, sec := reviewToReassign(t)
	ctx := t.Context()
	_, err := s.ApproveReview(ctx, "team", parent, "Sec", "fine", 0)
	require.NoError(t, err)

	require.True(t, s.InReviewByAuthor(ctx, "team", parent, "Dev"))
	assert.False(t, s.InReviewByAuthor(ctx, "team", parent, "QA"), "only the author")
	orch, reopened, err := s.NewRevisionInReview(ctx, "team", parent, "Dev", "rework", "", "the Operator's rework", nil, nil, "")
	require.NoError(t, err)
	assert.Equal(t, "lead", orch)
	require.NotNil(t, reopened)
	assert.Equal(t, 2, reopened.Round)

	got := roundReviewers(t, s, parent)
	assert.Equal(t, "pending", got["QA"].State)
	assert.Equal(t, "pending", got["Sec"].State, "an approval of the old revision does not carry over")
	assert.Equal(t, qa.ID, got["QA"].ReviewTaskID, "the same review tasks")
	assert.Equal(t, sec.ID, got["Sec"].ReviewTaskID)
	task, err := s.GetTask(ctx, "team", parent)
	require.NoError(t, err)
	assert.Equal(t, "review_pending", task.Status)
	assert.Equal(t, "the Operator's rework", task.Workflow.CompletionReview.Reason)

	_, err = s.ApproveReview(ctx, "team", parent, "QA", "old round", 1)
	require.Error(t, err, "a verdict on the superseded round is refused")
	_, err = s.ApproveReview(ctx, "team", parent, "QA", "ok", 2)
	require.NoError(t, err)
	v, err := s.ApproveReview(ctx, "team", parent, "Sec", "ok", 2)
	require.NoError(t, err)
	assert.True(t, v.Complete)
}

func TestANewRevisionIsRefusedFromAnyoneButTheAuthorOrOnceTheRoundHasConcluded(t *testing.T) {
	s, parent, _, _ := reviewToReassign(t)
	ctx := t.Context()
	_, _, err := s.NewRevisionInReview(ctx, "team", parent, "QA", "x", "", "not mine", nil, nil, "")
	require.Error(t, err)
	_, err = s.ApproveReview(ctx, "team", parent, "QA", "ok", 0)
	require.NoError(t, err)
	_, err = s.ApproveReview(ctx, "team", parent, "Sec", "ok", 0)
	require.NoError(t, err)
	_, _, err = s.NewRevisionInReview(ctx, "team", parent, "Dev", "x", "", "too late", nil, nil, "")
	require.Error(t, err, "an approved round is not reopened by a new revision")
}
