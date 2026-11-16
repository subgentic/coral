package board

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func takenOffRig(t *testing.T) (*Store, context.Context, int64) {
	s, ctx := perfStore(t)
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}, {"Sec", "Security"}} {
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
	_, _, err = s.DelegateReview(ctx, "team", task.ID, "lead", []string{"QA", "Sec"})
	require.NoError(t, err)
	return s, ctx, task.ID
}

// #17613: the Orchestrator re-delegated a round naming only Security, so QA's review task was skipped and QA was off the round; QA had already read the work and 'task approve' was refused (403) until the Orchestrator
// delegated again. A reviewer taken off an OPEN round who then gives a verdict is put back on it, their review task reopened in place, and the board says why; the verdict counts.
func TestAReviewerTakenOffAnOpenRoundCanStillGiveTheirVerdict(t *testing.T) {
	s, ctx, id := takenOffRig(t)
	_, _, err := s.DelegateReview(ctx, "team", id, "lead", []string{"Sec"})
	require.NoError(t, err)
	w, err := loadWorkflow(ctx, s.db, id)
	require.NoError(t, err)
	require.Len(t, w.ReviewRounds[0].Reviewers, 1, "QA is off the round")

	v, err := s.ApproveReview(ctx, "team", id, "QA", "fine", 0)
	require.NoError(t, err, "the verdict is not refused")
	assert.Equal(t, "completed", v.ReviewTask.Status, "their own review task finished")
	w, err = loadWorkflow(ctx, s.db, id)
	require.NoError(t, err)
	states := map[string]string{}
	for _, r := range w.ReviewRounds[0].Reviewers {
		states[r.Reviewer] = r.State
	}
	assert.Equal(t, map[string]string{"Sec": "pending", "QA": "approved"}, states, "back on the round with their verdict; Security still to give theirs")
	assert.False(t, v.Complete, "the round waits for Security")
	msgs, err := s.ListMessages(ctx, "team", 50, 0, 0)
	require.NoError(t, err)
	var said bool
	for _, m := range msgs {
		if strings.Contains(m.Content, "QA") && strings.Contains(m.Content, "taken off") && strings.Contains(m.Content, "#"+strconv.FormatInt(id, 10)) {
			said = true
		}
	}
	assert.True(t, said, "the board says why their review was reopened")
	last, err := s.ApproveReview(ctx, "team", id, "Sec", "fine", 0)
	require.NoError(t, err)
	assert.True(t, last.Complete, "both approvals complete the round")
	assert.ElementsMatch(t, []string{"Sec", "QA"}, last.Approvers)
}

// A reviewer who was never on the task is still refused, and so is one whose round has ended: the reopening is only for a reviewer taken off the open round.
func TestSomeoneNeverOnTheRoundIsStillRefused(t *testing.T) {
	s, ctx, id := takenOffRig(t)
	_, err := s.ApproveReview(ctx, "team", id, "lead", "fine", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "only the reviewers")
	_, err = s.RejectReview(ctx, "team", id, "QA", "no", 0)
	require.NoError(t, err)
	_, _, err = s.DelegateReview(ctx, "team", id, "lead", []string{"Sec"})
	require.Error(t, err, "the round has ended: no open round to change")
}
