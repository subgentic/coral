package routes

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21461: the Inbox page lists "Goal looks done" rows from the goals it reads, so each goal says whether the computer holds its row back (done_state.held): the rule of /api/needs-you (#21442), one source.
func (g *goalDoneRig) held(gl *board.Goal) bool {
	g.t.Helper()
	g.h.SetGoalDoneHidden(func(context.Context) []string { return nil })
	g.h.SetGoalDoneRead(func(context.Context) []string { return nil })
	got, err := g.bs.GetGoal(context.Background(), "team", gl.ID)
	require.NoError(g.t, err)
	g.h.attachGoalDoneState(asPerson(httptest.NewRequest("GET", "/api/goals", nil)), got)
	return got.DoneState != nil && got.DoneState.Held
}

func TestTheGoalsReadSaysWhichRowsAreHeld(t *testing.T) {
	g := newGoalDoneRig(t)
	driven := g.goal("Driven", "Dev")
	g.finishTask(driven)
	assert.True(t, g.held(driven), "a goal with a driver is held back")
	open := g.goal("Open", "Dev")
	assert.False(t, g.held(open), "a goal that does not look done carries no hold")

	_, err := g.bs.Unsubscribe(context.Background(), "team", "Lead")
	require.NoError(t, err)
	_, err = g.bs.Unsubscribe(context.Background(), "team", "Dev")
	require.NoError(t, err)
	free := g.goal("Nobody drives it", "")
	g.finishTask(free)
	assert.False(t, g.held(free), "a goal nobody drives is listed the first time")
	g.finishTask(free) // another task done: a new all-done state. A read of the goals recorded nothing (#21470), so it is still the first time
	assert.False(t, g.held(free), "a read of the goals does not write the once")
	g.listed(free) // the Inbox drew the row
	g.finishTask(free)
	assert.True(t, g.held(free), "a goal the Inbox listed once is not listed again for a new all-done state")

	g.settings["goal_done_driven_items"] = "true"
	assert.False(t, g.held(driven), "the setting brings the rows back")
	assert.False(t, g.held(free))
}

// listed is the Inbox page's "I drew this row" (POST .../done-state {"state":"listed"}).
func (g *goalDoneRig) listed(gl *board.Goal) {
	g.t.Helper()
	got, err := g.bs.GetGoal(context.Background(), "team", gl.ID)
	require.NoError(g.t, err)
	g.h.recordListed(context.Background(), got)
}
