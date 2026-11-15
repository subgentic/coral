package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17612: a task entering review goes to the default reviewers and to ONE member of the reviewer pool, the one with the fewest open reviews.
func TestASubmitGoesToTheLeastBusyMemberOfTheReviewerPool(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	qas := []string{"QA 1", "QA 2", "QA 3", "QA 4", "QA 5"}
	for i, n := range append([]string{"Orchestrator", "Security Reviewer", "Dev"}, qas...) {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	h := s.GetHealthSettings(ctx, "p")
	h.DefaultReviewers, h.ReviewerPool = []string{"Security Reviewer"}, qas
	require.NoError(t, s.SetHealthSettings(ctx, "p", h))

	submit := func(author string) []string {
		task, err := s.CreateTaskWithOpts(ctx, "p", "T", "", "medium", "Orchestrator", nil, author)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status='review_pending' WHERE id=?", task.ID)
		require.NoError(t, err)
		got, err := s.GetTask(ctx, "p", task.ID)
		require.NoError(t, err)
		names, source, _, err := s.AutoReviewers(ctx, "p", got, "Orchestrator", false)
		require.NoError(t, err)
		if len(names) > 1 {
			assert.Contains(t, source, "picked from the pool: least open reviews", "names=%v author=%s", names, author)
		}
		_, _, err = s.DelegateReview(ctx, "p", task.ID, "Orchestrator", names)
		require.NoError(t, err)
		return names
	}
	count := map[string]int{}
	for i := 0; i < 20; i++ {
		names := submit("Dev")
		require.Len(t, names, 2, "Security always, plus one QA")
		assert.Equal(t, "Security Reviewer", names[0])
		count[names[1]]++
	}
	for _, q := range qas {
		assert.Equal(t, 4, count[q], "20 submits spread evenly over 5: %v", count)
	}

	// The author is never picked; a QA a person put to sleep is skipped.
	for _, q := range qas[1:] {
		_, err = s.db.ExecContext(ctx, "UPDATE board_subscribers SET is_active=0 WHERE subscriber_id=?", q)
		require.NoError(t, err)
	}
	names := submit("QA 1")
	assert.Equal(t, []string{"Security Reviewer"}, names, "the only QA left is the author: Security alone")
}

func TestAMemberOfTheReviewerPoolIsOfferedReviewsOnABareClaim(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "QA 1", "Dev"} {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	h := s.GetHealthSettings(ctx, "p")
	h.ReviewerPool = []string{"QA 1"}
	require.NoError(t, s.SetHealthSettings(ctx, "p", h))
	build, err := s.CreateTaskWithOpts(ctx, "p", "build", "", "medium", "Orchestrator", nil, "")
	require.NoError(t, err)
	got, err := s.ClaimTask(ctx, "p", "QA 1")
	require.NoError(t, err)
	assert.Nil(t, got, "a bare claim by a pool member does not hand out a build task")
	got, err = s.ClaimTask(ctx, "p", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got, "anyone else still gets it")
	assert.Equal(t, build.ID, got.ID)
}

func TestAReviewTaskTakesTheGoalOfTheTaskItReviews(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "QA 1", "Dev"} {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	g, err := s.CreateGoal(ctx, "p", GoalInput{Title: "Goal", Outcome: "o", DoneWhen: "d", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	task, err := s.CreateTaskWithOpts(ctx, "p", "T", "", "medium", "Orchestrator", &CreateTaskOpts{GoalID: &g.ID}, "Dev")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status='review_pending' WHERE id=?", task.ID)
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "p", task.ID, "Orchestrator", []string{"QA 1"})
	require.NoError(t, err)
	require.Len(t, reviews, 1)
	rt, err := s.GetTask(ctx, "p", reviews[0].ID)
	require.NoError(t, err)
	require.NotNil(t, rt.GoalID)
	assert.Equal(t, g.ID, *rt.GoalID)
}
