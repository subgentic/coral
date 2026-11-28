package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21685: the task an agent is on is the one in progress, else the oldest queued one; a finished or reassigned task moves it; boards do not mix.
func TestCurrentTasksIsTheInProgressTaskElseTheOldestQueued(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, b := range []string{"alpha", "beta"} {
		_, err := s.Subscribe(ctx, b, "Dev", "Dev", "", nil, "")
		require.NoError(t, err)
	}
	cur := func() map[string]CurrentTask {
		m, err := s.CurrentTasks(ctx)
		require.NoError(t, err)
		return m
	}
	assert.Empty(t, cur(), "no task, nobody is on one")

	first, err := s.CreateTask(ctx, "alpha", "queued first", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "alpha", "queued second", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	got := cur()[CurrentTaskKey("alpha", "dev")] // the assignee is matched without case
	assert.Equal(t, CurrentTask{ID: first.ID, Title: "queued first", Status: "pending"}, got, "the oldest queued task")

	_, err = s.ClaimTask(ctx, "alpha", "Dev", second.ID)
	require.NoError(t, err)
	got = cur()[CurrentTaskKey("alpha", "Dev")]
	assert.Equal(t, CurrentTask{ID: second.ID, Title: "queued second", Status: "in_progress"}, got, "in progress beats an older queued task")

	_, err = s.CompleteTask(ctx, "alpha", second.ID, "Dev", nil)
	require.NoError(t, err)
	assert.Equal(t, first.ID, cur()[CurrentTaskKey("alpha", "Dev")].ID, "a finished task moves the agent to the next queued one")

	_, err = s.ReassignTask(ctx, "alpha", first.ID, "Someone Else")
	require.NoError(t, err)
	_, onIt := cur()[CurrentTaskKey("alpha", "Dev")]
	assert.False(t, onIt, "a reassigned task is no longer this agent's")
	assert.Equal(t, first.ID, cur()[CurrentTaskKey("alpha", "Someone Else")].ID)
	_, onBeta := cur()[CurrentTaskKey("beta", "Someone Else")]
	assert.False(t, onBeta, "a task on one board is not on another")
}

// #22048: a backlog task (task add --later) is not what its assignee is on: a bare claim never offers it, so the sidebar shows no task line and no "queued" for it.
func TestCurrentTasksSkipsTheBacklog(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "alpha", "Dev", "Dev", "", nil, "")
	require.NoError(t, err)
	later, err := s.CreateTask(ctx, "alpha", "for later", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	_, err = s.SetBacklog(ctx, "alpha", later.ID)
	require.NoError(t, err)
	m, err := s.CurrentTasks(ctx)
	require.NoError(t, err)
	_, on := m[CurrentTaskKey("alpha", "Dev")]
	assert.False(t, on, "a backlog-only agent is on no task")

	next, err := s.CreateTask(ctx, "alpha", "do now", "", "medium", "Dev", "Dev")
	require.NoError(t, err)
	m, err = s.CurrentTasks(ctx)
	require.NoError(t, err)
	assert.Equal(t, next.ID, m[CurrentTaskKey("alpha", "Dev")].ID, "the queued task the agent will claim, not the older backlog one")
}
