package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaimedTaskAnywhereIsTheMostImportantInProgressTaskOnAnyBoard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, b := range []string{"alpha", "beta"} {
		_, err := s.Subscribe(ctx, b, "Dev", "Dev", "", nil, "")
		require.NoError(t, err)
	}
	_, _, _, ok, err := s.ClaimedTaskAnywhere(ctx, "Dev")
	require.NoError(t, err)
	assert.False(t, ok, "nothing claimed yet")

	low, err := s.CreateTask(ctx, "alpha", "low one", "", "low", "Dev", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "alpha", "Dev", low.ID)
	require.NoError(t, err)
	id, project, prio, ok, err := s.ClaimedTaskAnywhere(ctx, "dev") // the name is not case-sensitive
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, [3]any{low.ID, "alpha", "low"}, [3]any{id, project, prio})

	crit, err := s.CreateTask(ctx, "beta", "critical one", "", "critical", "Dev", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "beta", "Dev", crit.ID)
	require.NoError(t, err)
	id, project, prio, ok, err = s.ClaimedTaskAnywhere(ctx, "Dev")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, [3]any{crit.ID, "beta", "critical"}, [3]any{id, project, prio}, "the more important task, on another board, ranks the agent")
	_, _, _, ok, _ = s.ClaimedTaskAnywhere(ctx, "Someone Else")
	assert.False(t, ok)
}
