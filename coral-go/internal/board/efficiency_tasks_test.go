package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8915: a finished task's work time is from its (last) claim to its last submission for review, or to its completion when it had none: review time is not counted. Review tasks are not work.
func TestEfficiencyTasksCountWorkNotReview(t *testing.T) {
	rt := newEffTeam(t, "Security")
	// the task under review: claimed at 10:00:00, handed in at 10:01:40, completed at 10:16:40 (fifteen minutes of review)
	_, err := rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET claimed_at = '2026-10-20T10:00:00Z', claim_thinking = 'high', input_tokens = 70, output_tokens = 30, cost_usd = 1.5 WHERE id = ?`, rt.parent.ID)
	require.NoError(t, err)
	w, err := loadWorkflow(rt.ctx, rt.s.db, rt.parent.ID)
	require.NoError(t, err)
	require.NotNil(t, w.CompletionReview)
	w.CompletionReview.SubmittedAt = "2026-10-20T10:01:40Z"
	require.NoError(t, saveWorkflow(rt.ctx, rt.s.db, rt.parent.ID, w))
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "ok", 1)
	require.NoError(t, err)
	_, err = rt.s.CompleteApprovedReview(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET completed_at = '2026-10-20T10:16:40Z' WHERE id = ?`, rt.parent.ID)
	require.NoError(t, err)

	// a task with no review: claimed 11:00, completed 11:05
	plain, err := rt.s.CreateTask(rt.ctx, "team", "Plain", "", "low", "Lead", "Worker")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", plain.ID)
	require.NoError(t, err)
	_, err = rt.s.CompleteTask(rt.ctx, "team", plain.ID, "Worker", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET claimed_at = '2026-10-20T11:00:00Z', completed_at = '2026-10-20T11:05:00Z' WHERE id = ?`, plain.ID)
	require.NoError(t, err)

	// a task nobody claimed (completed by hand): no work time
	hand, err := rt.s.CreateTask(rt.ctx, "team", "By hand", "", "low", "Lead", "Worker")
	require.NoError(t, err)
	_, err = rt.s.CompleteTask(rt.ctx, "team", hand.ID, "Lead", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET completed_at = '2026-10-20T12:00:00Z' WHERE id = ?`, hand.ID)
	require.NoError(t, err)

	got, err := rt.s.EfficiencyTasks(rt.ctx, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")
	require.NoError(t, err)
	byID := map[int64]EfficiencyTask{}
	for _, g := range got {
		byID[g.ID] = g
	}
	require.Len(t, got, 3, "the reviewer's own review task is not listed")
	reviewed := byID[rt.parent.ID]
	require.NotNil(t, reviewed.WorkSeconds)
	assert.InDelta(t, 100, *reviewed.WorkSeconds, 0.001, "claim to the hand-in, not to the completion")
	assert.Equal(t, "Worker", reviewed.Claimer, "the author, though the orchestrator holds it in review")
	assert.Equal(t, "high", reviewed.Thinking)
	assert.EqualValues(t, 100, reviewed.Tokens)
	assert.InDelta(t, 1.5, reviewed.CostUSD, 0.001)
	assert.False(t, reviewed.SentBack)
	p := byID[plain.ID]
	require.NotNil(t, p.WorkSeconds)
	assert.InDelta(t, 300, *p.WorkSeconds, 0.001, "no review: claim to completion")
	assert.Equal(t, "Worker", p.Claimer)
	assert.Equal(t, "", p.Thinking)
	assert.Nil(t, byID[hand.ID].WorkSeconds, "no claim time, no work time")

	none, err := rt.s.EfficiencyTasks(rt.ctx, "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z")
	require.NoError(t, err)
	assert.Empty(t, none)
}

// A task a reviewer sent back is marked sent back, and its work time is from the last claim to the last hand-in.
func TestEfficiencyTasksMarkASentBackTask(t *testing.T) {
	rt := newEffTeam(t, "Security")
	_, err := rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	_, err = rt.s.RejectReview(rt.ctx, "team", rt.parent.ID, "Security", "no", 1)
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", rt.parent.ID)
	require.NoError(t, err)
	_, err = rt.s.SubmitCompletionReview(rt.ctx, "team", rt.parent.ID, "Worker", "again", "success", "fixed", nil)
	require.NoError(t, err)
	_, _, err = rt.s.HandToOrchestrator(rt.ctx, "team", rt.parent.ID, "Worker")
	require.NoError(t, err)
	_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "now ok", 2)
	require.NoError(t, err)
	_, err = rt.s.CompleteApprovedReview(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	got, err := rt.s.EfficiencyTasks(rt.ctx, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.True(t, got[0].SentBack)
	assert.Equal(t, "Worker", got[0].Claimer)
}

// effTeam is a board with an orchestrator (Lead), an author (Worker) and reviewers, with a task of the author's handed in and delegated.
type effTeam struct {
	s      *Store
	ctx    context.Context
	parent *Task
	review map[string]*Task // the review task of each reviewer
}

func newEffTeam(t *testing.T, reviewers ...string) *effTeam {
	t.Helper()
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	_, err = s.Subscribe(ctx, "team", "Lead", "Orchestrator", "lead-session", nil, "all")
	require.NoError(t, err)
	for _, who := range append([]string{"Worker"}, reviewers...) {
		_, err = s.Subscribe(ctx, "team", who, who, who+"-session", nil, "mentions")
		require.NoError(t, err)
	}
	parent, err := s.CreateTask(ctx, "team", "Build it", "", "critical", "Lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", parent.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReview(ctx, "team", parent.ID, "Worker", "built", "success", "done", nil)
	require.NoError(t, err)
	_, _, err = s.HandToOrchestrator(ctx, "team", parent.ID, "Worker")
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "team", parent.ID, "Lead", reviewers)
	require.NoError(t, err)
	et := &effTeam{s: s, ctx: ctx, parent: parent, review: map[string]*Task{}}
	for _, r := range reviews {
		et.review[*r.AssignedTo] = r
	}
	return et
}

// #8968: a send-back keeps the work of the round it ended: the task's time is every round's claim to hand-in, not only the last.
func TestEfficiencyTasksKeepTheWorkOfTheRoundsBeforeTheLast(t *testing.T) {
	rt := newEffTeam(t, "Security")
	handedIn := func(claimed, submitted string) {
		_, err := rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET claimed_at = ? WHERE id = ?`, claimed, rt.parent.ID)
		require.NoError(t, err)
		w, err := loadWorkflow(rt.ctx, rt.s.db, rt.parent.ID)
		require.NoError(t, err)
		require.NotNil(t, w.CompletionReview)
		w.CompletionReview.SubmittedAt = submitted
		require.NoError(t, saveWorkflow(rt.ctx, rt.s.db, rt.parent.ID, w))
	}
	handedIn("2026-10-20T10:00:00Z", "2026-10-20T10:01:40Z") // round one: 100 s of work
	_, err := rt.s.ClaimTask(rt.ctx, "team", "Security", rt.review["Security"].ID)
	require.NoError(t, err)
	_, err = rt.s.RejectReview(rt.ctx, "team", rt.parent.ID, "Security", "no", 1) // a day of waiting for the verdict is not work
	require.NoError(t, err)
	var before float64
	require.NoError(t, rt.s.db.GetContext(rt.ctx, &before, `SELECT COALESCE(work_before_seconds, 0) FROM board_tasks WHERE id = ?`, rt.parent.ID))
	assert.InDelta(t, 100, before, 0.001, "the rejection kept round one's work")
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", rt.parent.ID)
	require.NoError(t, err)
	_, err = rt.s.SubmitCompletionReview(rt.ctx, "team", rt.parent.ID, "Worker", "again", "success", "fixed", nil)
	require.NoError(t, err)
	handedIn("2026-10-21T12:00:00Z", "2026-10-21T12:10:00Z") // round two: 600 s
	_, _, err = rt.s.HandToOrchestrator(rt.ctx, "team", rt.parent.ID, "Worker")
	require.NoError(t, err)
	_, err = rt.s.ApproveReview(rt.ctx, "team", rt.parent.ID, "Security", "ok", 2)
	require.NoError(t, err)
	_, err = rt.s.CompleteApprovedReview(rt.ctx, "team", rt.parent.ID, "Lead", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET completed_at = '2026-10-21T13:00:00Z' WHERE id = ?`, rt.parent.ID)
	require.NoError(t, err)
	got, err := rt.s.EfficiencyTasks(rt.ctx, "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z")
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.NotNil(t, got[0].WorkSeconds)
	assert.InDelta(t, 700, *got[0].WorkSeconds, 0.001, "100 s of round one and 600 s of round two, not the review of either")
	assert.True(t, got[0].SentBack)
	assert.Equal(t, []WorkWindow{{"2026-10-20T10:00:00Z", "2026-10-20T10:01:40Z"}, {"2026-10-21T12:00:00Z", "2026-10-21T12:10:00Z"}}, got[0].Windows, "both rounds' claim and hand-in (#8999)")

	// an approved task sent back after completion keeps its round too
	_, err = rt.s.SendBack(rt.ctx, "team", rt.parent.ID, "Lead", "one more thing")
	require.NoError(t, err)
	require.NoError(t, rt.s.db.GetContext(rt.ctx, &before, `SELECT COALESCE(work_before_seconds, 0) FROM board_tasks WHERE id = ?`, rt.parent.ID))
	assert.InDelta(t, 100+600, before, 0.001)
}

// #8968: a review task is not work even when its workflow cannot be read or is missing, and the window is compared as instants.
func TestEfficiencyTasksLeaveOutReviewTitlesAndReadTheWindowAsInstants(t *testing.T) {
	rt := newEffTeam(t, "Security")
	rv, err := rt.s.CreateTask(rt.ctx, "team", "Review #42: something", "", "low", "Lead", "Worker")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", rv.ID)
	require.NoError(t, err)
	_, err = rt.s.CompleteTask(rt.ctx, "team", rv.ID, "Worker", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET claimed_at = '2026-10-20T10:00:00Z', completed_at = '2026-10-20T10:05:00Z' WHERE id = ?`, rv.ID)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `DELETE FROM task_workflows WHERE task_id = ?`, rv.ID)
	require.NoError(t, err)
	plain, err := rt.s.CreateTask(rt.ctx, "team", "Real", "", "low", "Lead", "Worker")
	require.NoError(t, err)
	_, err = rt.s.ClaimTask(rt.ctx, "team", "Worker", plain.ID)
	require.NoError(t, err)
	_, err = rt.s.CompleteTask(rt.ctx, "team", plain.ID, "Worker", nil)
	require.NoError(t, err)
	_, err = rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET claimed_at = '2026-10-20T09:00:00Z', completed_at = '2026-10-20T10:00:00.500Z' WHERE id = ?`, plain.ID)
	require.NoError(t, err)

	got, err := rt.s.EfficiencyTasks(rt.ctx, "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z")
	require.NoError(t, err)
	require.Len(t, got, 1, "the review-titled task is out; the task completed half a second after the start is in")
	assert.Equal(t, plain.ID, got[0].ID)
	got, err = rt.s.EfficiencyTasks(rt.ctx, "2026-10-20T00:00:00Z", "2026-10-20T10:00:00Z")
	require.NoError(t, err)
	assert.Empty(t, got, "and half a second after the end is not in the window before it")
}

// #8968: the session recorded at the claim is the task's session.
func TestEfficiencyTasksNameTheSessionRecordedAtTheClaim(t *testing.T) {
	rt := newEffTeam(t, "Security")
	_, err := rt.s.db.ExecContext(rt.ctx, `UPDATE board_tasks SET session_id = 'sess-at-claim', claimed_at = '2026-10-20T10:00:00Z', completed_at = '2026-10-20T10:30:00Z', status = 'completed' WHERE id = ?`, rt.parent.ID)
	require.NoError(t, err)
	got, err := rt.s.EfficiencyTasks(rt.ctx, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "sess-at-claim", got[0].Session)
}
