package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A parked task does not hold its owner's active-task slot (#7819): parking the task a member is working on lets it claim another, the parked task keeps its status and owner, and unparking it gives
// the slot back (or, when the owner has claimed another meanwhile, puts the task back to pending, still its owner's, so a member never has two in progress).
func TestParkingTheTaskInProgressReleasesTheOwnersSlotAndUnparkingTakesItBack(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	first, err := s.CreateTask(ctx, "team", "First", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "team", "Second", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	claimed, err := s.ClaimTask(ctx, "team", "Worker", first.ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", claimed.Status)

	// before parking: the slot is held
	_, err = s.ClaimTask(ctx, "team", "Worker", second.ID)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "complete your current task")

	// parked: the slot is free, the task keeps its status and owner
	parked, err := s.ParkTask(ctx, "team", first.ID, "waiting on the operator", time.Time{})
	require.NoError(t, err)
	assert.Equal(t, "in_progress", parked.Status)
	require.NotNil(t, parked.AssignedTo)
	assert.Equal(t, "Worker", *parked.AssignedTo)
	got, err := s.ClaimTask(ctx, "team", "Worker", second.ID)
	require.NoError(t, err, "park, then claim another")
	require.NotNil(t, got)
	assert.Equal(t, second.ID, got.ID)

	// unparked while the owner holds the slot with another task: back to pending, the owner kept
	unparked, err := s.UnparkTask(ctx, "team", first.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", unparked.Status, "never two in progress")
	require.NotNil(t, unparked.AssignedTo)
	assert.Equal(t, "Worker", *unparked.AssignedTo, "unpark keeps the owner")
	assert.Nil(t, unparked.ParkedReason)

	// unparked with a free slot: in progress again
	third, err := s.CreateTask(ctx, "team", "Third", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "team", second.ID, "Worker", nil)
	require.NoError(t, err)
	claimed, err = s.ClaimTask(ctx, "team", "Worker", third.ID)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", claimed.ID, "later", time.Time{})
	require.NoError(t, err)
	back, err := s.UnparkTask(ctx, "team", claimed.ID)
	require.NoError(t, err)
	assert.Equal(t, "in_progress", back.Status, "the slot was free: the task is in progress again")
}

// A parked end that has passed holds the slot again, and a pending parked task is not claimed (as before).
func TestAParkingThatHasEndedHoldsTheSlotAgain(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	first, err := s.CreateTask(ctx, "team", "First", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "team", "Second", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", first.ID)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", first.ID, "until a moment ago", time.Now().Add(-time.Minute))
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", second.ID)
	require.Error(t, err, "a parking whose end has passed is no parking: the slot is held")
}

// The other readers of "in progress" follow the same rule (QA Reviewer 2's probe): a parked task is not the member's task in hand. The upload link (#7739) finds the one task after a park and a claim, the
// assignee is not busy with only a parked task, such a member is idle, and its posts do not touch the parked task's activity.
func TestTheOtherReadersOfInProgressIgnoreAParkedTask(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	first, err := s.CreateTask(ctx, "team", "First", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "team", "Second", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", first.ID)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", first.ID, "waiting", time.Time{})
	require.NoError(t, err)

	// only a parked task: not busy, idle
	busy, err := s.HasActiveTaskForAssignee(ctx, "team", "Worker", 0)
	require.NoError(t, err)
	assert.False(t, busy, "a member with only a parked task is not busy with it")
	idle := s.FindIdleSubscriber(ctx, "team", nil)
	require.NotNil(t, idle, "and is idle")
	assert.Equal(t, "Worker", idle.SubscriberID)
	ids, err := s.InProgressTaskIDsOf(ctx, "team", "Worker")
	require.NoError(t, err)
	assert.Empty(t, ids)

	// park, claim another: the one task in hand is the second
	_, err = s.ClaimTask(ctx, "team", "Worker", second.ID)
	require.NoError(t, err)
	ids, err = s.InProgressTaskIDsOf(ctx, "team", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{second.ID}, ids, "an upload links to the second task, not to nothing")
	busy, _ = s.HasActiveTaskForAssignee(ctx, "team", "Worker", 0)
	assert.True(t, busy)
	assert.Nil(t, s.FindIdleSubscriber(ctx, "team", nil), "busy with the second")

	// unparked while the slot is held: still only the second
	_, err = s.UnparkTask(ctx, "team", first.ID)
	require.NoError(t, err)
	ids, err = s.InProgressTaskIDsOf(ctx, "team", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{second.ID}, ids, "the unparked task went back to pending")
}
