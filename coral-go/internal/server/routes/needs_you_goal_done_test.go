package routes

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11825: an active goal whose tasks are all done is ONE item of what waits for the Operator, "Goal #N looks done: <title>", kind goal_done, counted once, gone when the goal closes. Not yet (kept with the
// all-done total it was pressed at) hides it until a task is added; Ignore hides it for good. The saved list is goal_done_hidden, read on every request.
func TestNeedsYouHasOneItemForAGoalWhoseTasksAreAllDone(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil) // a board is listed once it has something on it
	require.NoError(t, err0)
	hidden := []string{}
	h.SetGoalDoneHidden(func(context.Context) []string { return hidden })
	goal := func(title string, in board.GoalInput) *board.Goal {
		in.Title, in.CreatedBy = title, "Lead"
		g, err := bs.CreateGoal(ctx, "team", in)
		require.NoError(t, err)
		return g
	}
	task := func(g *board.Goal, finish bool) *board.Task {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		if finish {
			_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
			require.NoError(t, err)
			_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
			require.NoError(t, err)
		}
		return tk
	}
	read := func() []map[string]any {
		code, out := readNeedsYou(t, h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		var got []map[string]any
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_done" {
				got = append(got, it)
			}
		}
		assert.EqualValues(t, len(got), out["counts"].(map[string]any)["goal_done"], "counted once each")
		assert.EqualValues(t, len(got), out["count"], "and in the one count")
		return got
	}

	done := goal("Ship the export", board.GoalInput{DoneWhen: "the export runs"})
	task(done, true)
	task(done, true)
	open := goal("Still going", board.GoalInput{})
	task(open, true)
	task(open, false)
	goal("No tasks yet", board.GoalInput{})
	blocked := goal("Blocked one", board.GoalInput{})
	task(blocked, true)
	_, err := bs.UpdateGoal(ctx, "team", blocked.ID, board.GoalUpdate{State: ptrString(board.GoalBlocked), BlockedOn: ptrString("waiting on a vendor")})
	require.NoError(t, err)

	items := read()
	require.Len(t, items, 1, "only the goal whose tasks are all done: not one with an open task, none, or a blocked goal")
	assert.Equal(t, fmt.Sprintf("Goal #%d looks done: Ship the export", done.ID), items[0]["line"])
	assert.Equal(t, fmt.Sprintf("goal_done:team:%d", done.ID), items[0]["id"])
	assert.Equal(t, "team", items[0]["team"])
	assert.NotEmpty(t, items[0]["at"])

	hidden = []string{fmt.Sprintf("team|%d|2", done.ID)}
	assert.Empty(t, read(), "Not yet hides it at the total it was pressed at")
	added := task(done, false)
	assert.Empty(t, read(), "a goal with an open task is not done")
	_, err = bs.ClaimTask(ctx, "team", "Dev", added.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", added.ID, "Dev", nil)
	require.NoError(t, err)
	require.Len(t, read(), 1, "a task was added since Not yet (the total is 3, it was pressed at 2): the item is back")
	hidden = []string{fmt.Sprintf("team|%d|3", done.ID)}
	assert.Empty(t, read(), "and Not yet at the new total hides it again")
	hidden = []string{fmt.Sprintf("team|%d|*", done.ID)}
	assert.Empty(t, read(), "Ignore hides it whatever the total")
	hidden = []string{fmt.Sprintf("team|%d|3 ", done.ID), fmt.Sprintf("other|%d|*", done.ID)}
	assert.Len(t, read(), 1, "an entry that is not exactly the key, or is another team's, hides nothing")
	hidden = nil
	_, _, err = bs.CloseGoal(ctx, "team", done.ID, "all true", board.GoalDone)
	require.NoError(t, err)
	assert.Empty(t, read(), "gone when the goal closes")
}
