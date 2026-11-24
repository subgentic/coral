package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21173 (seen on #21161): a reviewer completed their review task by hand on an earlier round's notice. Round 3 arrived and 'task approve --round 3' was refused with "your review task is not open", and
// 'task review --to' said "no change" and made no task: nobody could record the verdict.
func TestAReviewerWhoseReviewTaskWasClosedCanStillGiveTheNewRoundsVerdict(t *testing.T) {
	// the same reviewer, re-delegated while the round is open
	t.Run("re-delegate", func(t *testing.T) {
		rt := newReviewTeam(t, "Security", "QA")
		msg := "read it"
		_, err := rt.s.CompleteTaskWithArtifacts(rt.ctx, "team", rt.review["Security"].ID, "Security", &msg, "success", nil)
		require.NoError(t, err)
		require.Equal(t, "completed", rt.get(rt.review["Security"].ID).Status)
		_, created, err := rt.s.DelegateReview(rt.ctx, "team", rt.parent.ID, "Lead", []string{"Security", "QA"})
		require.NoError(t, err)
		assert.Len(t, created, 1, "the closed review task is opened again and told, like a new one")
		assert.Equal(t, "pending", rt.get(rt.review["Security"].ID).Status)
		_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "fine", 1)
		require.NoError(t, err)
	})
	// a rejection, a resubmission: round 2 opens every reviewer's task, closed or not
	t.Run("resubmit", func(t *testing.T) {
		rt := newReviewTeam(t, "Security", "QA")
		msg := "read it"
		_, err := rt.s.CompleteTaskWithArtifacts(rt.ctx, "team", rt.review["Security"].ID, "Security", &msg, "success", nil)
		require.NoError(t, err)
		_, err = rt.s.RejectReview(rt.ctx, "team", rt.parent.ID, "QA", "no", 1)
		require.NoError(t, err)
		_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", rt.parent.ID)
		require.NoError(t, err)
		_, err = rt.s.SubmitCompletionReview(rt.ctx, "team", rt.parent.ID, "Worker", "fixed", "success", "done", nil)
		require.NoError(t, err)
		_, _, err = rt.s.HandToOrchestrator(rt.ctx, "team", rt.parent.ID, "Worker")
		require.NoError(t, err)
		assert.Equal(t, "pending", rt.get(rt.review["Security"].ID).Status)
		_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "fine", 2)
		require.NoError(t, err)
	})
}
