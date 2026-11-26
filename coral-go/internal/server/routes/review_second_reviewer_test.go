package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21747: naming a second reviewer one command later adds them; it never takes the first off the round. The task completes only when every reviewer of the round has approved, and a reviewer's open review task is never skipped by the other's approval.
func TestASecondReviewToAddsAReviewerAndTheTaskWaitsForBoth(t *testing.T) {
	base, h, task := reviewTeam(t, "team", true)
	ctx := context.Background()
	submit(t, base, task.ID)
	code, out := postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"QA Engineer"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"Security Reviewer"}})
	require.Equal(t, http.StatusOK, code, "%v", out)

	got, _ := h.bs.GetTask(ctx, "team", task.ID)
	round := got.Workflow.ReviewRounds[0]
	require.Len(t, round.Reviewers, 2, "both are on the round")
	assert.Empty(t, round.Dropped, "nobody was taken off")
	qa, sec := round.Reviewers[0], round.Reviewers[1]
	assert.Equal(t, "QA Engineer", qa.Reviewer)

	code, out = postCode(t, base(task.ID, "approve"), map[string]any{"subscriber_id": "Security Reviewer", "round": 1, "task_version": 1})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, _ = h.bs.GetTask(ctx, "team", task.ID)
	assert.Equal(t, "review_pending", got.Status, "the first approval does not complete it")
	rt, _ := h.bs.GetTask(ctx, "team", qa.ReviewTaskID)
	assert.Equal(t, "pending", rt.Status, "the other review task is still open, not skipped")
	_, err := h.bs.ClaimTask(ctx, "team", "QA Engineer", qa.ReviewTaskID)
	require.NoError(t, err, "and claimable")

	code, out = postCode(t, base(task.ID, "approve"), map[string]any{"subscriber_id": "QA Engineer", "round": 1, "task_version": 1})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, _ = h.bs.GetTask(ctx, "team", task.ID)
	assert.Equal(t, "completed", got.Status, "the second approval completes it")
	_ = sec
}

// replace is the way to take a reviewer off: the named reviewers are then the whole round.
func TestReviewToWithReplaceTakesTheOthersOff(t *testing.T) {
	base, h, task := reviewTeam(t, "team", true)
	ctx := context.Background()
	submit(t, base, task.ID)
	code, _ := postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"QA Engineer"}})
	require.Equal(t, http.StatusOK, code)
	code, out := postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"Security Reviewer"}, "replace": true})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, _ := h.bs.GetTask(ctx, "team", task.ID)
	round := got.Workflow.ReviewRounds[0]
	require.Len(t, round.Reviewers, 1)
	assert.Equal(t, "Security Reviewer", round.Reviewers[0].Reviewer)
	require.Len(t, round.Dropped, 1)
	assert.Equal(t, "QA Engineer", round.Dropped[0].Reviewer)
}
