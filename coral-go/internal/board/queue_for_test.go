package board

import (
	"context"
	"testing"

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
