package board

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

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

// #17749 (a): the review is made without the goal only when the goal is CLOSED; any other refusal is an error, not a silent unlinked review.
func TestAReviewDropsTheGoalOnlyWhenItIsClosed(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "QA 1", "Dev"} {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	submit := func(g int64) *Task {
		task, err := s.CreateTaskWithOpts(ctx, "p", "T", "", "medium", "Orchestrator", &CreateTaskOpts{GoalID: &g}, "Dev")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status='review_pending' WHERE id=?", task.ID)
		require.NoError(t, err)
		return task
	}
	closed, err := s.CreateGoal(ctx, "p", GoalInput{Title: "Closed", Outcome: "o", DoneWhen: "d", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	task := submit(closed.ID)
	_, _, err = s.CloseGoal(ctx, "p", closed.ID, "done", GoalDone)
	require.NoError(t, err)
	_, reviews, err := s.DelegateReview(ctx, "p", task.ID, "Orchestrator", []string{"QA 1"})
	require.NoError(t, err, "a closed goal: the review is made without it")
	rt, err := s.GetTask(ctx, "p", reviews[0].ID)
	require.NoError(t, err)
	assert.Nil(t, rt.GoalID)

	gone, err := s.CreateGoal(ctx, "p", GoalInput{Title: "Gone", Outcome: "o", DoneWhen: "d", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	task = submit(gone.ID)
	_, err = s.db.ExecContext(ctx, "DELETE FROM board_goals WHERE id=?", gone.ID)
	require.NoError(t, err)
	_, _, err = s.DelegateReview(ctx, "p", task.ID, "Orchestrator", []string{"QA 1"})
	assert.ErrorIs(t, err, ErrGoalNotFound, "a goal that is not there is not 'closed': the error is returned")
}

// #17749 (b): when the pool cannot pick, the hand-off line says so. (d): the tie-break reads created_at as a time.
func TestThePoolSaysWhenNobodyIsFreeAndComparesStampsAsTime(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "Security Reviewer", "QA 1", "Dev"} {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	h := s.GetHealthSettings(ctx, "p")
	h.DefaultReviewers, h.ReviewerPool = []string{"Security Reviewer"}, []string{"QA 1"}
	require.NoError(t, s.SetHealthSettings(ctx, "p", h))
	_, err = s.db.ExecContext(ctx, "UPDATE board_subscribers SET is_active=0 WHERE subscriber_id='QA 1'")
	require.NoError(t, err)
	task, err := s.CreateTaskWithOpts(ctx, "p", "T", "", "medium", "Orchestrator", nil, "Dev")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status='review_pending' WHERE id=?", task.ID)
	require.NoError(t, err)
	got, err := s.GetTask(ctx, "p", task.ID)
	require.NoError(t, err)
	names, source, _, err := s.AutoReviewers(ctx, "p", got, "Orchestrator", false)
	require.NoError(t, err)
	assert.Equal(t, []string{"Security Reviewer"}, names)
	assert.Contains(t, source, "pool: nobody free")

	// 09:00+01:00 is 08:00Z: earlier than 08:30Z, though it sorts after it as text.
	a, b := parseStamp("2026-11-15T09:00:00+01:00"), parseStamp("2026-11-15T08:30:00Z")
	assert.True(t, a.Before(b), "%v %v", a, b)
	assert.True(t, parseStamp("2026-11-15 08:30:00").Equal(time.Date(2026, 11, 15, 8, 30, 0, 0, time.UTC)))
	assert.True(t, parseStamp("not a time").IsZero())
}

// A review task whose created_at cannot be read ranks its member as given a review longest ago; that is said in the log, not done silently (#17807).
func TestAnUnreadableReviewStampIsLoggedNotSilentlyRankedOldest(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "Dev", "QA 1", "QA 2"} {
		_, err := s.Subscribe(ctx, "p", n, n, fmt.Sprintf("claude-%d", i), nil, "all")
		require.NoError(t, err)
	}
	h := s.GetHealthSettings(ctx, "p")
	h.ReviewerPool = []string{"QA 1", "QA 2"}
	require.NoError(t, s.SetHealthSettings(ctx, "p", h))
	submit := func() []string {
		task, err := s.CreateTaskWithOpts(ctx, "p", "T", "", "medium", "Orchestrator", nil, "Dev")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status='review_pending' WHERE id=?", task.ID)
		require.NoError(t, err)
		got, err := s.GetTask(ctx, "p", task.ID)
		require.NoError(t, err)
		names, _, _, err := s.AutoReviewers(ctx, "p", got, "Orchestrator", false)
		require.NoError(t, err)
		_, _, err = s.DelegateReview(ctx, "p", task.ID, "Orchestrator", names)
		require.NoError(t, err)
		return names
	}
	first := submit()
	require.Len(t, first, 1)
	_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET created_at='not a time' WHERE assigned_to=? AND id IN (SELECT task_id FROM task_workflows WHERE COALESCE(json_extract(data, '$.review_of'), 0) > 0)", first[0])
	require.NoError(t, err)

	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(old)
	submit()
	assert.Contains(t, buf.String(), "created_at cannot be read", "the unreadable stamp is logged")
	assert.Contains(t, buf.String(), first[0], "naming the member it ranked")
}
