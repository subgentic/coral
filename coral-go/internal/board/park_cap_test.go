package board

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A park whose end has passed does not count toward the cap (#11660, with #11659): it is no park any more, as the claim and the lists see it.
func TestALapsedParkDoesNotCountTowardTheCap(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	mk := func(title string) int64 {
		task, err := s.CreateTask(ctx, "team", title, "", "medium", "lead", "Dev")
		require.NoError(t, err)
		return task.ID
	}
	lapsed1, lapsed2, now1, now2, third := mk("L1"), mk("L2"), mk("N1"), mk("N2"), mk("N3")
	for _, id := range []int64{lapsed1, lapsed2} {
		_, err := s.ParkTask(ctx, "team", id, "waited a day", time.Now().Add(-time.Minute))
		require.NoError(t, err, "the store takes any end; the route limits it")
	}
	_, err := s.ParkTask(ctx, "team", now1, "x", time.Time{})
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", now2, "x", time.Time{})
	require.NoError(t, err, "two lapsed parks do not make this the third")
	_, err = s.ParkTask(ctx, "team", third, "x", time.Time{})
	assert.Error(t, err, "two live parks are the cap")
}

// An agent holds at most MaxParkedPerAgent parked tasks (#11660): a park is for a wait outside the team, and work that is not for now is released to the queue. Only a new park is refused; one that is
// parked already can change its reason, parks made over the cap before it are left alone, and another agent's or an unassigned task's parks do not count.
func TestAnAgentHoldsAtMostTwoParkedTasks(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	mk := func(title, who string) int64 {
		var task *Task
		var err error
		if who == "" {
			task, err = s.CreateTask(ctx, "team", title, "", "medium", "lead")
		} else {
			task, err = s.CreateTask(ctx, "team", title, "", "medium", "lead", who)
		}
		require.NoError(t, err)
		return task.ID
	}
	a1, a2, a3, b1, loose := mk("A1", "Dev"), mk("A2", "Dev"), mk("A3", "Dev"), mk("B1", "Other"), mk("Loose", "")
	_, err := s.ParkTask(ctx, "team", a1, "waiting on the operator", time.Time{})
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", a2, "waiting on the other team", time.Time{})
	require.NoError(t, err)

	_, err = s.ParkTask(ctx, "team", a3, "one more", time.Time{})
	var capErr *ErrParkCap
	require.True(t, errors.As(err, &capErr), "%v", err)
	assert.Equal(t, 2, capErr.Held)
	assert.Contains(t, err.Error(), "release one to the queue or finish one")
	got, _ := s.GetTask(ctx, "team", a3)
	assert.Nil(t, got.ParkedReason, "the refused park changed nothing")

	_, err = s.ParkTask(ctx, "team", a1, "a new reason", time.Time{})
	require.NoError(t, err, "a task that is parked already may change its reason")
	_, err = s.ParkTask(ctx, "team", b1, "x", time.Time{})
	require.NoError(t, err, "another agent's count is its own")
	_, err = s.ParkTask(ctx, "team", loose, "x", time.Time{})
	require.NoError(t, err, "an unassigned task has no owner to cap")

	// Releasing one makes room; unparking does too.
	_, err = s.ReleaseTask(ctx, "team", a2, false)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", a3, "now there is room", time.Time{})
	require.NoError(t, err)

	// Parks made over the cap stay as they are: the store never unparks one.
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET parked_reason = 'old park' WHERE board_id = 'team' AND id = ?`, a2)
	require.NoError(t, err)
	for _, id := range []int64{a1, a2, a3} {
		task, _ := s.GetTask(ctx, "team", id)
		assert.True(t, task.Parked(time.Now()), "#%d", id)
	}
	since, err := s.ParkedSince(ctx, "team")
	require.NoError(t, err)
	assert.Contains(t, since, a1)
	assert.NotContains(t, since, a2, "a park made before the time was recorded has none")
}

// Release puts work back in the queue: pending, claim and park cleared, unassigned unless kept; finished work and work under review cannot be released.
func TestReleaseSendsNotNowWorkBackToTheQueue(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Developer", "claude-dev", nil, "all")
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "Work", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", task.ID, "waiting on the operator", time.Time{})
	require.NoError(t, err)

	kept, err := s.ReleaseTask(ctx, "team", task.ID, true)
	require.NoError(t, err)
	assert.Equal(t, "pending", kept.Status)
	require.NotNil(t, kept.AssignedTo)
	assert.Equal(t, "Dev", *kept.AssignedTo, "kept assigned")
	assert.Nil(t, kept.ParkedReason, "a release ends the park")
	assert.Nil(t, kept.ClaimedAt)

	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	free, err := s.ReleaseTask(ctx, "team", task.ID, false)
	require.NoError(t, err)
	assert.Equal(t, "pending", free.Status)
	assert.True(t, free.AssignedTo == nil || *free.AssignedTo == "", "unassigned")

	done, err := s.CreateTask(ctx, "team", "Done", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", done.ID)
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "team", done.ID, "Dev", nil)
	require.NoError(t, err)
	_, err = s.ReleaseTask(ctx, "team", done.ID, false)
	assert.True(t, errors.Is(err, ErrNotReleasable), "%v", err)
	_, err = s.ReleaseTask(ctx, "team", 9999, false)
	assert.Error(t, err)
}
