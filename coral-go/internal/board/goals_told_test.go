package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11866: the time the Orchestrator was told of a goal is set once and never moves, so two writers racing to announce tell it once; it is not a change of the goal.
func TestAGoalsOrchestratorToldAtIsSetOnce(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g, err := s.CreateGoal(ctx, "team", GoalInput{Title: "A goal", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	assert.Nil(t, g.OrchestratorToldAt, "not told when made")
	before := g.UpdatedAt

	first, at, err := s.MarkGoalOrchestratorTold(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.True(t, first)
	assert.NotEmpty(t, at)
	again, _, err := s.MarkGoalOrchestratorTold(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.False(t, again, "the second call is not the one that told")

	got, err := s.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	require.NotNil(t, got.OrchestratorToldAt)
	assert.Equal(t, at, *got.OrchestratorToldAt, "the first time stays")
	assert.Equal(t, before, got.UpdatedAt, "it is not a change of the goal")

	// another board's goal of the same id, a missing goal and a bad call are not it
	other, _, err := s.MarkGoalOrchestratorTold(ctx, "other", g.ID)
	require.NoError(t, err)
	assert.False(t, other)
	_, _, err = s.MarkGoalOrchestratorTold(ctx, "", g.ID)
	assert.Error(t, err)
	_, _, err = s.MarkGoalOrchestratorTold(ctx, "team", 0)
	assert.Error(t, err)
}
