package board

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17643: the commit at the head of the author's branch is recorded at submit-review, named in the reviewers' review tasks, and stamped on each verdict, so an approval says
// which commit it covers and a brief never names a different one.
func TestTheSubmittedHeadIsNamedForReviewersAndStampedOnTheirVerdict(t *testing.T) {
	s, ctx := perfStore(t)
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}} {
		_, err := s.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	task, err := s.CreateTask(ctx, "team", "reviewed", "body", "high", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", []TaskArtifact{{Name: "c.md", Content: "c"}}, nil, "")
	require.NoError(t, err)

	require.Error(t, s.SetSubmittedHead(ctx, "team", task.ID, "the trial merge"), "free text is not a commit")
	head := "0123456789abcdef0123456789abcdef01234567"
	require.NoError(t, s.SetSubmittedHead(ctx, "team", task.ID, strings.ToUpper(head)))
	_, _, err = s.HandToOrchestrator(ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	_, reviewTasks, err := s.DelegateReview(ctx, "team", task.ID, "lead", []string{"QA"})
	require.NoError(t, err)
	require.Len(t, reviewTasks, 1)
	require.NotNil(t, reviewTasks[0].Body)
	assert.Contains(t, *reviewTasks[0].Body, "Submitted head: "+head[:12], "the review task names the commit")

	v, err := s.ApproveReview(ctx, "team", task.ID, "QA", "fine", 0)
	require.NoError(t, err)
	assert.Contains(t, *v.ReviewTask.CompletionMessage, "Approved task #", "the verdict message")
	assert.Contains(t, *v.ReviewTask.CompletionMessage, " at "+head[:12], "the verdict says which commit it covers")
	w, err := loadWorkflow(ctx, s.db, task.ID)
	require.NoError(t, err)
	require.Len(t, w.ReviewRounds, 1)
	assert.Equal(t, head, w.ReviewRounds[0].Reviewers[0].Head, "the approval records the commit")
}

func TestATaskSubmittedWithNoHeadReadsAsBefore(t *testing.T) {
	assert.True(t, ValidHead(""))
	assert.True(t, ValidHead("ABCDEF1"))
	assert.False(t, ValidHead("abc"))
	assert.False(t, ValidHead("not a sha"))
	assert.Equal(t, "", headOf(nil))
	assert.Equal(t, "0123456789ab", ShortHead("0123456789abcdef"))
	assert.NotContains(t, reviewTaskBody(1, "t", "a", 1, ""), "Submitted head")
}
