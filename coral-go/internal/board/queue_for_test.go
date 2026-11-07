package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14133: a subscriber's own queue, in the order claim takes it.
func TestQueueForIsTheOwnInProgressThenAssignedInClaimOrder(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	mk := func(prio, who string) int64 {
		tk, err := s.CreateTask(ctx, "alpha", "t", "", prio, "Orch", who)
		require.NoError(t, err)
		return tk.ID
	}
	q, err := s.QueueFor(ctx, "alpha", "Dev")
	require.NoError(t, err)
	assert.Empty(t, q.InProgress)
	assert.Empty(t, q.Assigned)

	a := mk("high", "Dev")
	_, err = s.ClaimTask(ctx, "alpha", "Dev", a)
	require.NoError(t, err)
	low := mk("low", "Dev")
	crit := mk("critical", "Dev")
	mid := mk("medium", "Dev")
	_ = mk("critical", "Other")
	cancelled := mk("critical", "Dev")
	_, err = s.CancelTask(ctx, "alpha", cancelled, "Dev", nil)
	require.NoError(t, err)

	q, err = s.QueueFor(ctx, "alpha", "Dev")
	require.NoError(t, err)
	assert.Equal(t, []int64{a}, q.InProgress)
	assert.Equal(t, []int64{crit, mid, low}, q.Assigned, "priority, then id; nobody else's and no cancelled task")

	other, err := s.QueueFor(ctx, "beta", "Dev")
	require.NoError(t, err)
	assert.Empty(t, other.InProgress, "another board's queue is its own")
	assert.Empty(t, other.Assigned)
}

// QA's SHOULD 3 on #14133: a parked task is set aside on purpose, so a restarted agent is not sent to it, and it is not the slot it holds.
func TestQueueForLeavesOutParkedTasksUntilTheyAreUnparked(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	mk := func(who string) int64 {
		tk, err := s.CreateTask(ctx, "alpha", "t", "", "high", "Orch", who)
		require.NoError(t, err)
		return tk.ID
	}
	active, waiting, heldWaiting := mk("Dev"), mk("Dev"), mk("Dev")
	_, err := s.ClaimTask(ctx, "alpha", "Dev", active)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "alpha", active, "waiting on the Operator", time.Time{})
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "alpha", heldWaiting, "held", time.Time{})
	require.NoError(t, err)

	q, err := s.QueueFor(ctx, "alpha", "Dev")
	require.NoError(t, err)
	assert.Empty(t, q.InProgress, "a parked in-progress task does not hold the slot and is not named")
	assert.Equal(t, []int64{waiting}, q.Assigned, "a parked pending task is not named either")

	// an end in the past is not parked any more
	_, err = s.ParkTask(ctx, "alpha", waiting, "short", time.Now().Add(-time.Minute))
	if err == nil {
		q, err = s.QueueFor(ctx, "alpha", "Dev")
		require.NoError(t, err)
		assert.Contains(t, q.Assigned, waiting, "a park that has ended leaves the task on the list")
	}
	_, err = s.UnparkTask(ctx, "alpha", active)
	require.NoError(t, err)
	q, err = s.QueueFor(ctx, "alpha", "Dev")
	require.NoError(t, err)
	assert.Equal(t, []int64{active}, q.InProgress, "unparked, it is the slot again")
}
