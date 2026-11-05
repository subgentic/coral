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

// #13566 (Backend Dev's INFOs): a claim of a task that already has files and a completion with none (while its completion review holds files) move the revision; a claim of a task without files does not.
func TestAClaimNotesTheArtifactsRevisionOnlyForATaskWithFiles(t *testing.T) {
	s, ctx := perfStore(t)
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"Dev2", "Backend Dev"}} {
		_, err := s.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	plain, err := s.CreateTask(ctx, "team", "no files", "body", "high", "lead", "Dev")
	require.NoError(t, err)
	before := s.ArtifactsRevision("team")
	_, err = s.ClaimTask(ctx, "team", "Dev", plain.ID)
	require.NoError(t, err)
	require.Equal(t, before, s.ArtifactsRevision("team"), "a claim of a task with no files stirs nothing")

	// No public flow reaches a claim of a task that still has files (a released review is not claimable by another builder, a send back clears them), so the note's rule is pinned on its helper: a task the store
	// says has files moves the revision, one without does not.
	withFiles, err := s.CreateTask(ctx, "team", "with files", "body", "high", "lead", "Dev2")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE task_workflows SET has_artifacts = 1 WHERE task_id = ?`, withFiles.ID)
	require.NoError(t, err)
	before = s.ArtifactsRevision("team")
	s.noteClaimedTaskFiles(ctx, "team", plain.ID)
	require.Equal(t, before, s.ArtifactsRevision("team"), "a task with no files: no note")
	s.noteClaimedTaskFiles(ctx, "team", withFiles.ID)
	require.NotEqual(t, before, s.ArtifactsRevision("team"), "a task that has files: the claim's assigned_to and session_id are the list's attribution, so the revision moves")
}

func TestACompletionWithNoFilesMovesTheArtifactsRevisionWhenTheCompletionReviewHoldsSome(t *testing.T) {
	s, ctx := perfStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Backend Dev", "Dev-session", nil, "all")
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "reviewed", "body", "high", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", []TaskArtifact{{Name: "candidate.md", Content: "c"}}, nil, "")
	require.NoError(t, err)
	before := s.ArtifactsRevision("team")
	_, err = s.CompleteTaskWithArtifacts(ctx, "team", task.ID, "Dev", nil, "success", nil)
	require.NoError(t, err)
	require.NotEqual(t, before, s.ArtifactsRevision("team"), "completing with no files still moves the revision: the files of its completion review take the completion's time")
}
