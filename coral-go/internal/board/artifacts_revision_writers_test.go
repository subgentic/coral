package board

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// #13566: a review verdict changes what the team's artifact list reads of the reviewed task (a rejection clears its completion review, an approval completes it): the board's artifacts revision moves,
// so the kept list is built again. (The writers that cannot change it say why in a comment at their saveWorkflow call.)
func TestAReviewVerdictMovesTheArtifactsRevision(t *testing.T) {
	for _, approve := range []bool{false, true} {
		s, ctx := perfStore(t)
		for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}} {
			_, err := s.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
			require.NoError(t, err)
		}
		task, err := s.CreateTask(ctx, "team", "reviewed", "body", "high", "lead", "Dev")
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
		require.NoError(t, err)
		_, err = s.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", []TaskArtifact{{Name: "candidate.md", Content: "c"}}, nil, "")
		require.NoError(t, err)
		_, _, err = s.HandToOrchestrator(ctx, "team", task.ID, "Dev")
		require.NoError(t, err)
		_, _, err = s.DelegateReview(ctx, "team", task.ID, "lead", []string{"QA"})
		require.NoError(t, err)
		before := s.ArtifactsRevision("team")
		if approve {
			_, err = s.ApproveReview(ctx, "team", task.ID, "QA", "fine", 0)
		} else {
			_, err = s.RejectReview(ctx, "team", task.ID, "QA", "not yet", 0)
		}
		require.NoError(t, err)
		require.NotEqual(t, before, s.ArtifactsRevision("team"), "approve=%v: the verdict moves the revision", approve)
	}
}
