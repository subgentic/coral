package routes

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #16781: a goal an agent closed as done is an item of Needs you (kind goal_closed), counted and pushed, until the Operator dismisses or reopens it. The client had it (#16753); the server did not.
func TestNeedsYouCountsAGoalClosedByAnAgent(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err0)
	dismissed := []string{}
	h.SetGoalClosedDismissed(func(context.Context) []string { return dismissed })

	makeGoal := func(title string) *board.Goal {
		g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: title, CreatedBy: "Lead"})
		require.NoError(t, err)
		return g
	}
	closeBy := func(g *board.Goal, by string) {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		_, err = bs.ClaimTask(ctx, "team", by, tk.ID)
		require.NoError(t, err)
		_, err = bs.CompleteTask(ctx, "team", tk.ID, by, nil)
		require.NoError(t, err)
		_, _, err = bs.CloseGoalBy(ctx, "team", g.ID, "all done", board.GoalDone, by)
		require.NoError(t, err)
	}

	read := func() []map[string]any {
		code, out := readNeedsYou(t, h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		var got []map[string]any
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_closed" {
				got = append(got, it)
			}
		}
		assert.EqualValues(t, len(got), out["counts"].(map[string]any)["goal_closed"], "counted once each")
		return got
	}

	// A goal closed by an agent appears.
	agentGoal := makeGoal("Ship the export")
	closeBy(agentGoal, "Dev")
	items := read()
	require.Len(t, items, 1, "a goal closed by an agent is one item")
	assert.Equal(t, fmt.Sprintf("Goal #%d closed as done by Dev: all done", agentGoal.ID), items[0]["line"])
	assert.Equal(t, fmt.Sprintf("goal_closed:team:%d", agentGoal.ID), items[0]["id"])
	assert.Equal(t, "team", items[0]["team"])
	assert.NotEmpty(t, items[0]["at"])

	// A goal the Operator closed does not appear.
	opGoal := makeGoal("Operator's goal")
	closeBy(opGoal, "Operator")
	items = read()
	require.Len(t, items, 1, "only the agent-closed goal, not the Operator-closed one")

	// Dismiss removes it.
	g, err := bs.GetGoal(ctx, "team", agentGoal.ID)
	require.NoError(t, err)
	closedAt := ""
	if g.ClosedAt != nil {
		closedAt = *g.ClosedAt
	}
	dismissed = []string{fmt.Sprintf("team|%d|%s", agentGoal.ID, closedAt)}
	assert.Empty(t, read(), "dismissed: gone")

	// Reopen and close again: a new close shows again (the old dismiss key has the old closed_at).
	dismissed = nil
	_, err = bs.UpdateGoal(ctx, "team", agentGoal.ID, board.GoalUpdate{State: ptrString(board.GoalActive)})
	require.NoError(t, err)
	assert.Empty(t, read(), "reopened: not listed")
	_, _, err = bs.CloseGoalBy(ctx, "team", agentGoal.ID, "done again", board.GoalDone, "Dev")
	require.NoError(t, err)
	items = read()
	require.Len(t, items, 1, "closed again by agent: back")
}

func TestGoalClosedByAgentWindowAndEdgeCases(t *testing.T) {
	now := time.Now().UTC()
	within := now.Add(-24 * time.Hour).Format(time.RFC3339)
	outside := now.Add(-15 * 24 * time.Hour).Format(time.RFC3339)

	tests := []struct {
		name string
		goal board.Goal
		want bool
	}{
		{"agent closed within window", board.Goal{State: board.GoalDone, ClosedBy: "Dev", ClosedAt: &within}, true},
		{"agent closed outside window", board.Goal{State: board.GoalDone, ClosedBy: "Dev", ClosedAt: &outside}, false},
		{"operator closed", board.Goal{State: board.GoalDone, ClosedBy: "Operator", ClosedAt: &within}, false},
		{"no closer", board.Goal{State: board.GoalDone, ClosedBy: "", ClosedAt: &within}, false},
		{"not done", board.Goal{State: board.GoalActive, ClosedBy: "Dev", ClosedAt: &within}, false},
		{"nil closed_at", board.Goal{State: board.GoalDone, ClosedBy: "Dev", ClosedAt: nil}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, goalClosedByAgent(tc.goal, now))
		})
	}
}
