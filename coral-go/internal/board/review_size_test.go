package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/reviewsize"
)

func TestReviewSizeSettingDefaultsOffAndRoundTrips(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	got, err := s.GetReviewSizeSetting(ctx, "team")
	if err != nil || got.On {
		t.Fatalf("default: %+v %v", got, err)
	}
	saved, err := s.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, Files: 20, Skip: []string{" *.lock ", "*.lock"}, OnlyRoles: []string{"Lead Developer"}})
	if err != nil || len(saved.Skip) != 1 {
		t.Fatalf("save: %+v %v", saved, err)
	}
	got, err = s.GetReviewSizeSetting(ctx, "team")
	if err != nil || !got.On || got.Lines != 800 || got.Files != 20 || got.Skip[0] != "*.lock" || got.OnlyRoles[0] != "Lead Developer" {
		t.Fatalf("read back: %+v %v", got, err)
	}
	if other, _ := s.GetReviewSizeSetting(ctx, "other"); other.On {
		t.Fatal("a setting is per team")
	}
	if _, err := s.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true}); err == nil {
		t.Fatal("on with no limit was saved")
	}
	if got, _ = s.GetReviewSizeSetting(ctx, "team"); got.Lines != 800 {
		t.Fatalf("a refused save changed the stored setting: %+v", got)
	}
}

func TestReviewSizeSettingThatCannotBeReadIsAnErrorNotOff(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SetBoardSetting(ctx, "team", settingReviewSize, "{not json"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetReviewSizeSetting(ctx, "team"); err == nil {
		t.Fatal("a broken value read as off")
	}
}

// Brief task 10 (#21059): Send back on the review size banner returns a task that is waiting in review to its author with the note, without a reviewer's rejection.
func TestSendBackFromReviewEndsTheOpenRoundAndReturnsTheTask(t *testing.T) {
	e := newVerEnv(t)
	id := e.inReview("big", []TaskArtifact{patchRow("fix", "d1")}, "rev1", "rev2")
	_, err := e.s.SendBackFromReview(e.ctx, "team", id, "Operator", "  ")
	require.ErrorContains(t, err, "needs a note")

	task, err := e.s.SendBackFromReview(e.ctx, "team", id, "Operator", "over the limit: please split it")
	require.NoError(t, err)
	assert.Equal(t, "pending", task.Status, "back with its author")
	require.NotNil(t, task.AssignedTo)
	assert.Equal(t, "worker", *task.AssignedTo)
	round := lastRound(t, task)
	assert.Equal(t, "rejected", round.Result, "the open round ended")
	assert.Equal(t, "Operator", round.SentBackBy)
	assert.Equal(t, "over the limit: please split it", round.SentBackNote)
	for _, r := range round.Reviewers {
		rt, err := e.s.GetTask(e.ctx, "team", r.ReviewTaskID)
		require.NoError(t, err)
		assert.Equal(t, "skipped", rt.Status, "%s's review of the old candidate is not offered any more", r.Reviewer)
	}
	_, err = e.s.SendBackFromReview(e.ctx, "team", id, "Operator", "again")
	require.ErrorContains(t, err, "not waiting in review", "a task that is back with its author is not sent back twice")

	// The author resubmits and the same reviewers are asked again, as after any rejection.
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", id)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", id, "worker", "split", "success", "smaller", []TaskArtifact{patchRow("fix", "d2")})
	require.NoError(t, err)
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", id, "worker")
	require.NoError(t, err)
}

func TestSendBackFromReviewWithNoRoundYetAndNotInReview(t *testing.T) {
	e := newVerEnv(t)
	id := e.inReviewNoDelegate("big", "rev1")
	task, err := e.s.SendBackFromReview(e.ctx, "team", id, "Operator", "too big")
	require.NoError(t, err, "nobody was asked to review it yet: it is simply returned")
	assert.Equal(t, "pending", task.Status)
	require.NotNil(t, task.AssignedTo)
	assert.Equal(t, "worker", *task.AssignedTo)

	done := e.done("small", "success", nil, nil)
	_, err = e.s.SendBackFromReview(e.ctx, "team", done, "Operator", "no")
	require.ErrorContains(t, err, "not waiting in review", "a completed task is not in review")
}
