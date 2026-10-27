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
	sessions, err := rt.s.SubscriberSessions(rt.ctx)
	require.NoError(t, err)
	assert.Equal(t, "Worker-session", sessions["team|Worker"])
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
