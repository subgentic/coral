package server

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// #7296 round 2: the block the board system prompt carries: open goals oldest first with done-when, a blocked goal with its reason, at most five, and nothing for a board with no open goal.
func TestBoardGoalsPromptBlock(t *testing.T) {
	bs, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	block := boardGoalsPromptBlock(bs)
	assert.Empty(t, block("team"), "no goals, no block")
	ctx := context.Background()
	g1, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the goals page", DoneWhen: "The page is in a release", CreatedBy: "Operator"})
	require.NoError(t, err)
	g2, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Cut the build time", CreatedBy: "Operator"})
	require.NoError(t, err)
	on := "the cache"
	blocked := board.GoalBlocked
	_, err = bs.UpdateGoal(ctx, "team", g2.ID, board.GoalUpdate{State: &blocked, BlockedOn: &on})
	require.NoError(t, err)
	_, _, err = bs.CloseGoal(ctx, "team", g1.ID, "done", board.GoalDone)
	require.NoError(t, err)
	_, err = bs.CreateGoal(ctx, "other", board.GoalInput{Title: "Another board's goal", CreatedBy: "Operator"})
	require.NoError(t, err)
	got := block("team")
	assert.Contains(t, got, "#"+strconv.FormatInt(g2.ID, 10)+" Cut the build time (blocked on the cache)")
	assert.NotContains(t, got, "Ship the goals page", "a closed goal is not listed")
	assert.NotContains(t, got, "Another board's goal")
	assert.Contains(t, got, "--goal <id>")
	for i := 0; i < 7; i++ {
		_, err := bs.CreateGoal(ctx, "busy", board.GoalInput{Title: "goal " + strconv.Itoa(i), DoneWhen: "d", CreatedBy: "Operator"})
		require.NoError(t, err)
	}
	busy := block("busy")
	assert.Equal(t, 5, strings.Count(busy, "— done when: d"), "five goals")
	assert.Contains(t, busy, "and more: coral-board goal list")
}
