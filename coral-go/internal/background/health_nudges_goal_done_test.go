package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
)

// #12161 (the Operator: "we are putting goals into the inbox to close out too quickly"): at the moment every task of a goal is done, the health check tells the goal's driver, or the Orchestrator when it has none,
// once: the next tasks can be added within 15 minutes, or the goal goes to the Operator. A new all-done state (after more tasks) is told again; the notice is a fixed template with the goal's number only.
func TestAGoalWhoseTasksAreAllDoneTellsItsDriverOnce(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	const leadSID, devSID = "11111111-0000-4000-8000-000000000011", "11111111-0000-4000-8000-000000000012"
	_, err := n.bs.Subscribe(ctx, "team", "Lead", "Orchestrator", naming.SessionName("claude", leadSID), nil, "all")
	require.NoError(t, err)
	n.agents = append(n.agents, AgentInfo{AgentType: "claude", SessionID: leadSID, DisplayName: "Lead"})
	n.agent("Dev", devSID)
	g, err := n.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Explore the options", Driver: "Dev", CreatedBy: "Lead"})
	require.NoError(t, err)
	orphan, err := n.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Owned by nobody", CreatedBy: "Lead"})
	require.NoError(t, err)
	task := func(goal int64, finish bool) {
		tk, err := n.bs.CreateTaskWithOpts(ctx, "team", "step", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &goal})
		require.NoError(t, err)
		if finish {
			_, err = n.bs.ClaimTask(ctx, "team", "Dev", tk.ID)
			require.NoError(t, err)
			_, err = n.bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
			require.NoError(t, err)
		}
	}
	n.now = time.Now().UTC()

	task(g.ID, false) // an open task: nothing to say
	n.run(time.Minute)
	assert.Empty(t, n.sentTo("Dev"), "a goal with an open task is not all done")

	task(g.ID, true)
	task(orphan.ID, true)
	n.now = time.Now().UTC()
	n.run(time.Minute) // the open one is still open: g has two tasks, one open
	assert.Empty(t, n.sentTo("Dev"), "one task is still open")
	list, err := n.bs.GoalPage(ctx, "team", board.GoalListQuery{States: []string{board.GoalActive}, Limit: 10})
	require.NoError(t, err)
	require.NotEmpty(t, list.Goals)

	orch := n.sentTo("Lead")
	require.Len(t, orch, 1, "a goal with no driver is the Orchestrator's to hear")
	assert.Contains(t, orch[0], fmt.Sprintf("Goal #%d", orphan.ID))
	assert.Contains(t, orch[0], "[Coral]", "a typed notice opens with [Coral]")
	assert.Contains(t, orch[0], "within 15 minutes", "the setting's number, 15 by default")
	assert.Contains(t, orch[0], "Operator", "it says where the goal goes")
	assert.NotContains(t, orch[0], "Owned by nobody", "no goal title is typed")

	n.run(2 * time.Minute)
	assert.Len(t, n.sentTo("Lead"), 1, "once, however long it stays all done (inside the window)")

	// the driver's goal: finish its open task, and the driver is told
	tasks, err := n.bs.ListTasks(ctx, "team")
	require.NoError(t, err)
	for _, tk := range tasks {
		if tk.GoalID != nil && *tk.GoalID == g.ID && tk.Status != "completed" {
			_, _ = n.bs.ClaimTask(ctx, "team", "Dev", tk.ID)
			_, err = n.bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
			require.NoError(t, err)
		}
	}
	n.now = time.Now().UTC()
	n.run(time.Minute)
	dev := n.sentTo("Dev")
	require.Len(t, dev, 1, "every task done: the driver is told")
	assert.Contains(t, dev[0], fmt.Sprintf("Goal #%d", g.ID))

	// more tasks, all done again: told again
	task(g.ID, true)
	n.now = time.Now().UTC().Add(5 * time.Minute) // after the cooldown of the earlier notice, inside the new window
	n.run(0)
	assert.Len(t, n.sentTo("Dev"), 2, "all done again, with more tasks: told again")

	// and never once the 15 minutes are over: the goal is the Operator's then
	task(orphan.ID, true)
	n.run(30 * time.Minute)
	assert.Len(t, n.sentTo("Lead"), 1, "nothing after the window")
	assert.Len(t, n.sentTo("Dev"), 2)
}

// The notice says the minutes of the Operator's setting (goal_done_quiet_minutes), as a number only; with the setting at 0 there is no quiet period and nothing to tell.
func TestTheGoalDoneNudgeSaysTheSettingsMinutes(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	const devSID = "11111111-0000-4000-8000-000000000021"
	n.agent("Dev", devSID)
	minutes := 40
	n.h.SetGoalDoneQuiet(func(context.Context) time.Duration { return time.Duration(minutes) * time.Minute })
	g, err := n.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Explore", Driver: "Dev", CreatedBy: "Dev"})
	require.NoError(t, err)
	tk, err := n.bs.CreateTaskWithOpts(ctx, "team", "step", "", "medium", "Dev", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_, err = n.bs.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = n.bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(t, err)
	n.now = time.Now().UTC()
	n.run(time.Minute)
	got := n.sentTo("Dev")
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "within 40 minutes")
	assert.NotContains(t, got[0], "15 minutes")

	// at 0 there is nothing to tell (the goal is the Operator's at once)
	minutes = 0
	tk2, err := n.bs.CreateTaskWithOpts(ctx, "team", "more", "", "medium", "Dev", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_, err = n.bs.ClaimTask(ctx, "team", "Dev", tk2.ID)
	require.NoError(t, err)
	_, err = n.bs.CompleteTask(ctx, "team", tk2.ID, "Dev", nil)
	require.NoError(t, err)
	n.now = time.Now().UTC().Add(5 * time.Minute)
	n.run(0)
	assert.Len(t, n.sentTo("Dev"), 1, "no quiet period, no notice")
}
