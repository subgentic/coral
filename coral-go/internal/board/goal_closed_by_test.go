package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15244 (Beta walk 12 H1): a goal an agent closed looked the same as one the person closed. The closer is kept, shown, and gone again when the goal is reopened.
func TestCloseGoalKeepsWhoClosedItAndReopenClearsIt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Ship it")
	closed, _, err := s.CloseGoalBy(ctx, "team", g.ID, "all tasks done", GoalDone, "Orchestrator")
	require.NoError(t, err)
	assert.Equal(t, "Orchestrator", closed.ClosedBy)
	got, err := s.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.Equal(t, "Orchestrator", got.ClosedBy, "read back from the store")
	active := GoalActive
	reopened, err := s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{State: &active})
	require.NoError(t, err)
	assert.Equal(t, "", reopened.ClosedBy, "a reopened goal has no closer")
	other := newGoal(t, s, "team", "Plain close")
	plain, _, err := s.CloseGoal(ctx, "team", other.ID, "done", GoalDone)
	require.NoError(t, err)
	assert.Equal(t, "", plain.ClosedBy, "the old call names no closer")
}
