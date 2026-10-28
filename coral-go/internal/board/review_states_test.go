package board

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// reviewStatesBoard is a board with every kind of task the open-review lines tell apart: a task waiting in review_pending, tasks with delegated reviews (one round reopened after a rejection),
// a finished review, and plain open and completed tasks.
func reviewStatesBoard(t *testing.T) (*Store, string) {
	t.Helper()
	s, ctx := perfStore(t)
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"Dev2", "Backend Dev"}, {"QA", "QA Engineer"}, {"Sec", "Security Reviewer"}} {
		_, err := s.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	submit := func(author, title string) int64 {
		task, err := s.CreateTask(ctx, "team", title, "body", "high", "lead", author)
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", author, task.ID)
		require.NoError(t, err)
		_, err = s.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, author, "built", "", "ready", nil, nil, "")
		require.NoError(t, err)
		_, _, err = s.HandToOrchestrator(ctx, "team", task.ID, author)
		require.NoError(t, err)
		return task.ID
	}
	submit("Dev", "waiting, not delegated")
	delegated := submit("Dev2", "delegated to two")
	_, _, err := s.DelegateReview(ctx, "team", delegated, "lead", []string{"QA", "Sec"})
	require.NoError(t, err)
	_, err = s.ApproveReview(ctx, "team", delegated, "Sec", "fine", 0)
	require.NoError(t, err)
	rejected := submit("Dev", "rejected, back with its author")
	_, _, err = s.DelegateReview(ctx, "team", rejected, "lead", []string{"QA"})
	require.NoError(t, err)
	_, err = s.RejectReview(ctx, "team", rejected, "QA", "not yet", 0)
	require.NoError(t, err)
	for i := 0; i < 5; i++ { // plain open tasks
		_, err := s.CreateTask(ctx, "team", fmt.Sprintf("open %d", i), "body", "low", "lead", "")
		require.NoError(t, err)
	}
	return s, "team"
}

// #9779: ListReviewStates answers what the health report's open-review lines need, and agrees with the hydrated read of every task on exactly the tasks and fields they use.
func TestListReviewStatesAgreesWithTheHydratedRead(t *testing.T) {
	s, team := reviewStatesBoard(t)
	ctx := t.Context()
	all, err := s.ListTasks(ctx, team)
	require.NoError(t, err)
	want := map[int64]Task{}
	for _, tk := range all {
		if tk.Status == "review_pending" || ((tk.Status == "pending" || tk.Status == "in_progress") && tk.Workflow.ReviewOf > 0) {
			want[tk.ID] = tk
		}
	}
	require.GreaterOrEqual(t, len(want), 3, "a review_pending task and two review tasks")
	got, err := s.ListReviewStates(ctx, team)
	require.NoError(t, err)
	require.Len(t, got, len(want))
	for _, g := range got {
		w, ok := want[g.ID]
		require.True(t, ok, "#%d is not a review task or a task in review", g.ID)
		assert.Equal(t, w.Status, g.Status)
		assert.Equal(t, w.AssignedTo, g.AssignedTo)
		assert.Equal(t, w.CreatedAt, g.CreatedAt)
		assert.Equal(t, w.Workflow.ReviewOf, g.Workflow.ReviewOf)
		assert.Equal(t, w.Workflow.ReviewRounds, g.Workflow.ReviewRounds)
		assert.Equal(t, w.Workflow.CompletionReview, g.Workflow.CompletionReview)
	}
	other, err := s.ListReviewStates(ctx, "another board")
	require.NoError(t, err)
	assert.Empty(t, other)
}

func TestListReviewStatesCostOnABigBoard(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 1,500 open tasks")
	}
	s, team := reviewStatesBoard(t)
	ctx := t.Context()
	body := strings.Repeat("A task body explains what to do. ", 60)
	for i := 0; i < 1500; i++ {
		_, err := s.CreateTask(ctx, team, fmt.Sprintf("open %d", i), body, "medium", "lead", "Dev")
		require.NoError(t, err)
	}
	states := bestOf(7, func() { _, _ = s.ListOpenTaskStates(ctx, team) })
	reviews := bestOf(7, func() { _, _ = s.ListReviewStates(ctx, team) })
	t.Logf("1,500 open tasks plus the review tasks: ListOpenTaskStates %v, ListReviewStates %v", states, reviews)
	assert.Less(t, reviews, states, "the review read costs less than the open-task read it sits beside")
}
