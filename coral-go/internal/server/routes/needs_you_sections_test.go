package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #22093: an agent item carries the goal and task of the task the agent has claimed (the live row's board_task), not one that only waits in its queue.
func TestNeedsYouAgentItemsCarryTheClaimedTaskAndItsGoal(t *testing.T) {
	now := time.Now()
	at := now.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	row := func(sid, status string, goal any) map[string]any {
		bt := map[string]any{"id": int64(412), "title": "Guest checkout", "status": status}
		if goal != nil {
			bt["goal_id"], bt["goal_title"] = int64(41), "Checkout redesign"
		}
		return map[string]any{"session_id": sid, "display_name": "Dev", "waiting_for_input": true, "waiting_since": at, "waiting_kind": "permission", "board_project": "team", "board_task": bt}
	}
	items := needsYouAgentItems([]map[string]any{row("s1", "in_progress", true), row("s2", "pending", true), row("s3", "in_progress", nil)}, now)
	require.Len(t, items, 3)
	assert.EqualValues(t, 412, items[0].TaskID)
	assert.EqualValues(t, 41, items[0].GoalID)
	assert.Equal(t, "Checkout redesign", items[0].GoalTitle)
	assert.Equal(t, "Guest checkout", items[0].TaskTitle)
	amb := row("s4", "in_progress", true)
	amb["board_task"].(map[string]any)["claims"] = 2
	assert.Zero(t, needsYouAgentItems([]map[string]any{amb}, now)[0].TaskID, "two claims: nothing is guessed")
	assert.Zero(t, items[1].TaskID, "a queued task is not the agent's claimed task")
	assert.EqualValues(t, 412, items[2].TaskID)
	assert.Zero(t, items[2].GoalID, "a task with no goal")
}

func TestCurrentTasksCarryTheGoal(t *testing.T) {
	_, bs := operatorAsksRig(t)
	ctx := context.Background()
	goal, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Checkout redesign", CreatedBy: "Lead"})
	require.NoError(t, err)
	task, err := bs.CreateTaskWithOpts(ctx, "team", "Guest checkout", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &goal.ID})
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	cur, err := bs.CurrentTasks(ctx)
	require.NoError(t, err)
	ct := cur[board.CurrentTaskKey("team", "Dev")]
	assert.Equal(t, goal.ID, ct.GoalID)
	assert.Equal(t, "Checkout redesign", ct.GoalTitle)
	assert.Zero(t, ct.Claims)

}

func TestNeedsYouGroupsOrderByNewestAfterThePermissionPrompts(t *testing.T) {
	items := []NeedsYouItem{
		{Kind: "question", Team: "t", GoalID: 38, At: "2026-11-27T10:00:00Z"},
		{Kind: "question", Team: "t", GoalID: 41, At: "2026-11-28T09:00:00Z"},
		{Kind: "question", Team: "t", GoalID: 41, At: "2026-11-28T08:00:00Z"},
		{Kind: "question", At: "2026-11-28T01:00:00Z"},
		{Kind: "agent", Permission: true, At: "2026-11-20T00:00:00Z"},
	}
	gs := needsYouGroups(items)
	keys := []string{}
	for _, g := range gs {
		keys = append(keys, g.Key)
	}
	assert.Equal(t, []string{"permission", "goal:t:41", "direct", "goal:t:38"}, keys)
	assert.Equal(t, 2, gs[1].Count)
	assert.Equal(t, "2026-11-28T09:00:00Z", gs[1].NewestAt)
}
