package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21701: backlog is a quiet park that is not counted against the park limit, is not offered to a bare claim, and is promoted by claiming it by number (or by unpark). A started task cannot go to the backlog.
func TestBacklogIsQuietNotCountedAndPromotedByAClaim(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.Subscribe(ctx, "team", "Worker", "Developer", "claude-w", nil, "all")
	require.NoError(t, err)
	var ids []int64
	for _, title := range []string{"a", "b", "c", "d"} {
		task, err := s.CreateTask(ctx, "team", title, "", "medium", "lead", "Worker")
		require.NoError(t, err)
		_, err = s.SetBacklog(ctx, "team", task.ID)
		require.NoError(t, err)
		ids = append(ids, task.ID)
	}
	// Four backlog tasks, past the default park limit of 3: a real park is still allowed.
	real, err := s.CreateTask(ctx, "team", "waits", "", "medium", "lead", "Worker")
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", real.ID, "waiting on the Operator", time.Time{})
	require.NoError(t, err, "backlog does not count against the park limit")

	got, err := s.ClaimTask(ctx, "team", "Worker")
	require.NoError(t, err)
	assert.Nil(t, got, "a bare claim is not offered backlog or a parked task")

	claimed, err := s.ClaimTask(ctx, "team", "Worker", ids[0])
	require.NoError(t, err)
	require.NotNil(t, claimed)
	assert.Equal(t, "in_progress", claimed.Status)
	assert.False(t, claimed.InBacklog(), "claiming by number promotes it")

	back, err := s.UnparkTask(ctx, "team", ids[1])
	require.NoError(t, err)
	assert.False(t, back.InBacklog(), "unpark promotes it")

	_, err = s.SetBacklog(ctx, "team", ids[0])
	require.Error(t, err, "a task in progress is not for later")
}
