package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #18089: a resubmitted high or critical round was offered "when their task ends" to a reviewer busy on a medium task while a member of the same role sat idle. The seat moves to the idle member
// and the round notice says so; a medium round, an equally urgent task, or nobody idle leaves it alone.
func TestAResubmittedUrgentRoundMovesOffABusyReviewerToAnIdlePeer(t *testing.T) {
	setup := func(t *testing.T, priority string, idlePeer bool, busyPriority string) (*Store, context.Context, *Task, *Task) {
		t.Helper()
		ctx := context.Background()
		s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
		require.NoError(t, err)
		t.Cleanup(func() { s.Close() })
		subs := [][2]string{{"Lead", "Orchestrator"}, {"Worker", "Developer"}, {"QA Engineer 5", "QA Engineer"}}
		if idlePeer {
			subs = append(subs, [2]string{"QA Engineer 3", "QA Engineer"})
		}
		for _, m := range subs {
			mode := "mentions"
			if m[0] == "Lead" {
				mode = "all"
			}
			_, err = s.Subscribe(ctx, "team", m[0], m[1], m[0]+"-session", nil, mode)
			require.NoError(t, err)
		}
		parent, err := s.CreateTask(ctx, "team", "Build it", "", priority, "Lead", "Worker")
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", "Worker", parent.ID)
		require.NoError(t, err)
		_, err = s.SubmitCompletionReview(ctx, "team", parent.ID, "Worker", "built", "success", "done", nil)
		require.NoError(t, err)
		_, _, err = s.HandToOrchestrator(ctx, "team", parent.ID, "Worker")
		require.NoError(t, err)
		_, reviews, err := s.DelegateReview(ctx, "team", parent.ID, "Lead", []string{"QA Engineer 5"})
		require.NoError(t, err)
		_, err = s.RejectReview(ctx, "team", parent.ID, "QA Engineer 5", "no", 1)
		require.NoError(t, err)
		// the round-1 reviewer picks up other work while the author fixes
		busy, err := s.CreateTask(ctx, "team", "Other work", "", busyPriority, "Lead", "QA Engineer 5")
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", "QA Engineer 5", busy.ID)
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", "Worker", parent.ID)
		require.NoError(t, err)
		_, err = s.SubmitCompletionReview(ctx, "team", parent.ID, "Worker", "fixed", "success", "done", nil)
		require.NoError(t, err)
		_, reopened, err := s.HandToOrchestrator(ctx, "team", parent.ID, "Worker")
		require.NoError(t, err)
		require.NotNil(t, reopened)
		return s, ctx, reviews[0], parent
	}
	owner := func(s *Store, ctx context.Context, id int64) string {
		task, err := s.GetTask(ctx, "team", id)
		require.NoError(t, err)
		require.NotNil(t, task.AssignedTo)
		return *task.AssignedTo
	}
	round2 := func(s *Store, ctx context.Context, id int64) ReviewRound {
		w, err := loadWorkflow(ctx, s.db, id)
		require.NoError(t, err)
		return w.ReviewRounds[len(w.ReviewRounds)-1]
	}

	s, ctx, review, parent := setup(t, "high", true, "medium")
	assert.Equal(t, "QA Engineer 3", owner(s, ctx, review.ID), "the idle member of the same role has the seat")
	r := round2(s, ctx, parent.ID)
	require.Len(t, r.Reviewers, 1)
	assert.Equal(t, "QA Engineer 3", r.Reviewers[0].Reviewer)
	assert.Contains(t, r.DelegatedBy, "QA Engineer 5")
	assert.Contains(t, r.DelegatedBy, "QA Engineer 3 (idle)", "the round notice says so")

	s, ctx, review, _ = setup(t, "medium", true, "low")
	assert.Equal(t, "QA Engineer 5", owner(s, ctx, review.ID), "a medium round keeps its reviewer")
	s, ctx, review, _ = setup(t, "high", true, "high")
	assert.Equal(t, "QA Engineer 5", owner(s, ctx, review.ID), "a reviewer on equally urgent work keeps the seat")
	s, ctx, review, _ = setup(t, "high", false, "medium")
	assert.Equal(t, "QA Engineer 5", owner(s, ctx, review.ID), "nobody idle: the seat stays")
}
