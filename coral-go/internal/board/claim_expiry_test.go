package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21700: a stale claim goes back to pending and stays its owner's; one with recent activity, a parked one and one no longer in progress are left alone.
func TestRequeueStaleClaimKeepsTheOwnerAndLeavesLiveWorkAlone(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "Old claim", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", task.ID)
	require.NoError(t, err)

	ok, err := s.RequeueStaleClaim(ctx, "team", task.ID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.False(t, ok, "activity since the cut: left alone")

	_, err = s.ParkTask(ctx, "team", task.ID, "waiting on the Operator", time.Time{})
	require.NoError(t, err)
	ok, err = s.RequeueStaleClaim(ctx, "team", task.ID, time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.False(t, ok, "a parked task is set aside on purpose")
	_, err = s.UnparkTask(ctx, "team", task.ID)
	require.NoError(t, err)

	ok, err = s.RequeueStaleClaim(ctx, "team", task.ID, time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.True(t, ok)
	got, err := s.GetTask(ctx, "team", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", got.Status)
	require.NotNil(t, got.AssignedTo)
	assert.Equal(t, "Worker", *got.AssignedTo, "back in its owner's queue")
	assert.Nil(t, got.ClaimedAt)

	ok, err = s.RequeueStaleClaim(ctx, "team", task.ID, time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.False(t, ok, "no longer in progress")
}

func TestClaimExpireHoursDefaultsAndBounds(t *testing.T) {
	assert.Equal(t, 72, DefaultHealthSettings().ClaimExpireHours)
	hs := DefaultHealthSettings()
	hs.ClaimExpireHours = 5000
	assert.Equal(t, ClaimExpireHoursMax, hs.Clamp().ClaimExpireHours)
	hs.ClaimExpireHours = 0
	assert.Equal(t, 0, hs.Clamp().ClaimExpireHours, "0 is off")
}
