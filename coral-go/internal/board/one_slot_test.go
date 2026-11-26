package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func inProgressOf(t *testing.T, s *Store, owner string) []int64 {
	t.Helper()
	tasks, err := s.ListTasks(context.Background(), "team")
	require.NoError(t, err)
	var ids []int64
	for _, task := range tasks {
		if task.Status == "in_progress" && task.AssignedTo != nil && *task.AssignedTo == owner {
			ids = append(ids, task.ID)
		}
	}
	return ids
}

// #21699: a member has one task in progress. A second claim, bare or by number, is refused naming the open
// task, and neither task is moved: the first stays in progress, the second stays pending.
func TestASecondClaimIsRefusedNamingTheOpenTask(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	first, err := s.CreateTask(ctx, "team", "Billing export", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "team", "Second", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", first.ID)
	require.NoError(t, err)

	for _, ids := range [][]int64{nil, {second.ID}} {
		_, err = s.ClaimTask(ctx, "team", "Worker", ids...)
		require.Error(t, err)
		assert.ErrorIs(t, err, errSlotHeld, "still the slot refusal")
		var held *SlotHeldError
		require.ErrorAs(t, err, &held)
		assert.Equal(t, first.ID, held.TaskID)
		assert.Contains(t, err.Error(), "#"+itoa64(first.ID))
		assert.Contains(t, err.Error(), "Billing export", "the open task is named")
		assert.Contains(t, err.Error(), "complete your current task before claiming a new one")
	}
	assert.Equal(t, []int64{first.ID}, inProgressOf(t, s, "Worker"), "nothing moved")
	got, err := s.GetTask(ctx, "team", second.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", got.Status)
}

// #21699: no other path puts a second task in progress: reassigning an in-progress task to a member who
// holds one sends it back to pending, and unparking one when its owner took another does the same.
func TestNoPathLeavesAMemberWithTwoTasksInProgress(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for _, n := range []string{"Worker", "Other"} {
		_, err := s.Subscribe(ctx, "team", n, "Developer", "claude-"+n, nil, "all")
		require.NoError(t, err)
	}
	mine, err := s.CreateTask(ctx, "team", "Mine", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	theirs, err := s.CreateTask(ctx, "team", "Theirs", "", "medium", "lead", "Other")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", mine.ID)
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Other", theirs.ID)
	require.NoError(t, err)

	// Reassign Other's in-progress task to Worker, who holds one: it goes back to pending.
	moved, err := s.ReassignTask(ctx, "team", theirs.ID, "Worker")
	require.NoError(t, err)
	assert.Equal(t, "pending", moved.Status)
	assert.Equal(t, []int64{mine.ID}, inProgressOf(t, s, "Worker"))

	// Park Worker's task, claim another, unpark the first: it waits as pending, the one in hand stays.
	_, err = s.ParkTask(ctx, "team", mine.ID, "waiting on the Operator", time.Time{})
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Worker", theirs.ID)
	require.NoError(t, err)
	back, err := s.UnparkTask(ctx, "team", mine.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", back.Status)
	assert.Equal(t, []int64{theirs.ID}, inProgressOf(t, s, "Worker"))
}
