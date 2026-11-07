package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12081: "Goal #N looks done" said it had waited 4 minutes the moment it appeared, because the page counted from the goal's own time. The goal pages carry when the last task was completed.
func TestAGoalWithAllItsTasksDoneSaysWhenTheLastOneWasCompleted(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Looks done")
	open := newGoal(t, s, "team", "Still going")
	mk := func(goal *Goal) *Task {
		task, err := s.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &CreateTaskOpts{GoalID: &goal.ID})
		require.NoError(t, err)
		return task
	}
	a, b, c := mk(g), mk(g), mk(open)
	for i, task := range []*Task{a, b, c} {
		_, err := s.ClaimTask(ctx, "team", "Dev"+string(rune('A'+i)), task.ID)
		require.NoError(t, err)
	}
	lookup := func() map[int64]*string {
		page, err := s.AllGoalsPage(ctx, AllGoalsQuery{})
		require.NoError(t, err)
		out := map[int64]*string{}
		for _, x := range page.Goals {
			out[x.ID] = x.LooksDoneAt
		}
		return out
	}
	_, err := s.CompleteTask(ctx, "team", a.ID, "DevA", nil)
	require.NoError(t, err)
	assert.Nil(t, lookup()[g.ID], "a task is still open: it does not look done")
	_, err = s.CompleteTask(ctx, "team", b.ID, "DevB", nil)
	require.NoError(t, err)
	got := lookup()
	require.NotNil(t, got[g.ID], "every task is done: it says since when")
	var last string
	require.NoError(t, s.reader().GetContext(ctx, &last, `SELECT MAX(completed_at) FROM board_tasks WHERE board_id = 'team' AND goal_id = ?`, g.ID))
	assert.Equal(t, last, *got[g.ID], "the last completion, not the goal's own time")
	assert.Nil(t, got[open.ID], "another goal with an open task has none")
	one, err := s.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	assert.Equal(t, GoalRollup{Done: 2, Total: 2}, one.Rollup)
}

func TestMovedGoalWorkPreventsAnOldCompletionHintAndPublishesItsReturn(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	from, to := newGoal(t, s, "team", "Ship the app"), newGoal(t, s, "team", "Follow-up")
	makeTask := func(g *Goal) *Task {
		tk, err := s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Lead", &CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		return tk
	}
	finish := func(tk *Task) {
		_, err := s.ClaimTask(ctx, "team", "Dev", tk.ID)
		require.NoError(t, err)
		_, err = s.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
		require.NoError(t, err)
	}
	done, open := makeTask(from), makeTask(from)
	finish(done)
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET completed_at='2000-01-01T00:00:00Z' WHERE id=?`, done.ID)
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", open.ID, &to.ID))
	old, err := s.GetGoal(ctx, "team", from.ID)
	require.NoError(t, err)
	assert.Equal(t, GoalRollup{Done: 1, Total: 1}, old.Rollup, "the attached-task count still describes current work")
	assert.Equal(t, 1, old.MovedOpen)
	assert.Nil(t, old.LooksDoneAt, "moving unfinished work is not completing it")
	var lastEvent int64
	require.NoError(t, s.reader().GetContext(ctx, &lastEvent, `SELECT MAX(id) FROM board_goal_events`))
	finish(open)
	old, err = s.GetGoal(ctx, "team", from.ID)
	require.NoError(t, err)
	require.NotNil(t, old.LooksDoneAt)
	assert.Zero(t, old.MovedOpen)
	var completed string
	require.NoError(t, s.reader().GetContext(ctx, &completed, `SELECT completed_at FROM board_tasks WHERE id=?`, open.ID))
	assert.Equal(t, completed, *old.LooksDoneAt, "the quiet period starts at the moved work's completion, not the old task's 2000 timestamp")
	var formerGoalEvents int
	require.NoError(t, s.reader().GetContext(ctx, &formerGoalEvents, `SELECT COUNT(*) FROM board_goal_events WHERE board_id='team' AND goal_id=? AND kind='task_state' AND id>?`, from.ID, lastEvent))
	assert.Positive(t, formerGoalEvents, "a live page of the former goal is told to refresh")
	page, err := s.GoalPage(ctx, "team", GoalListQuery{})
	require.NoError(t, err)
	for _, g := range page.Goals {
		if g.ID == from.ID {
			assert.Equal(t, old.LooksDoneAt, g.LooksDoneAt)
		}
	}
	// Completed work returning to a goal is a new candidate transition, not an ancient wait.
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET completed_at='2000-01-01T00:00:00Z' WHERE id=?`, open.ID)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_goal_task_moves SET moved_at='2000-01-01T00:00:00Z' WHERE board_id='team' AND goal_id=?`, from.ID)
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", open.ID, &from.ID))
	old, err = s.GetGoal(ctx, "team", from.ID)
	require.NoError(t, err)
	require.NotNil(t, old.LooksDoneAt)
	var arrived string
	require.NoError(t, s.reader().GetContext(ctx, &arrived, `SELECT arrived_at FROM board_goal_task_moves WHERE board_id='team' AND goal_id=? AND task_id=?`, from.ID, open.ID))
	assert.Equal(t, arrived, *old.LooksDoneAt, "returning completed work does not reuse the old completion time")
	// A row moved out of the board cannot reveal another board's completion or make this goal look complete.
	require.NoError(t, s.reader().GetContext(ctx, &lastEvent, `SELECT MAX(id) FROM board_goal_events`))
	beforeMove := goalSeq(t, s, "team")
	foreign := newGoal(t, s, "other", "Private work")
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET board_id='other',goal_id=? WHERE id=?`, foreign.ID, open.ID)
	require.NoError(t, err)
	old, err = s.GetGoal(ctx, "team", from.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, old.MovedOpen)
	assert.Nil(t, old.LooksDoneAt)
	assert.Equal(t, beforeMove+1, goalSeq(t, s, "team"), "the old board's counter changes once on departure")
	var oldRefresh, foreignLeak int
	require.NoError(t, s.reader().GetContext(ctx, &oldRefresh, `SELECT COUNT(*) FROM board_goal_events WHERE board_id='team' AND goal_id=? AND kind='task_unlinked' AND id>?`, from.ID, lastEvent))
	require.NoError(t, s.reader().GetContext(ctx, &foreignLeak, `SELECT COUNT(*) FROM board_goal_events WHERE board_id='other' AND goal_id=? AND id>?`, from.ID, lastEvent))
	assert.Positive(t, oldRefresh, "the source board is explicitly told to refresh its former goal")
	assert.Zero(t, foreignLeak, "the old goal's id is not published under the new board")
	require.NoError(t, s.ensureGoalsSchema(ctx), "the upgrade is idempotent")
}
