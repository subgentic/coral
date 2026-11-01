package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ReviewWaits names the tasks in review, with who holds the review and since when: the stale-review rule's data (#11729).
func TestReviewWaitsListsATaskInReviewWithItsHolder(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	_, err = s.Subscribe(ctx, "team", "reviewer", "Orchestrator", "reviewer-session", nil, "all")
	require.NoError(t, err)
	up, err := s.CreateTaskWithOpts(ctx, "team", "Build", "", "medium", "lead", &CreateTaskOpts{Workflow: TaskWorkflow{RequiredOutputs: []string{"build"}}}, "worker")
	require.NoError(t, err)
	other, err := s.CreateTask(ctx, "team", "Still open", "", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "worker", up.ID)
	require.NoError(t, err)
	none, err := s.ReviewWaits(ctx, "team")
	require.NoError(t, err)
	assert.Empty(t, none, "nothing is in review yet (the candidate is submitted, the slot not released)")
	_, err = s.SubmitCompletionReview(ctx, "team", up.ID, "worker", "built", "success", "external rejection reported", []TaskArtifact{{Name: "build", Content: "verified candidate", Revision: "revision-A"}})
	require.NoError(t, err)
	_, err = s.ReleaseCompletionReview(ctx, "team", up.ID, "reviewer", "waiting for a reviewer")
	require.NoError(t, err)
	got, err := s.ReviewWaits(ctx, "team")
	require.NoError(t, err)
	require.Len(t, got, 1, "the open task is not in review: %d", other.ID)
	assert.Equal(t, up.ID, got[0].Task)
	assert.Equal(t, []string{"worker"}, got[0].With, "no round has begun: the submitter holds it")
	assert.False(t, got[0].Started)
	assert.WithinDuration(t, time.Now(), got[0].Since, time.Minute)
}
