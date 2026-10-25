package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7355: goal events in the feed. An append-only table written by the same triggers that move a board's goals counter (seq), in the same transaction, so no writer of goals or board_tasks can forget one:
// ids, a kind and the counter value, no text.
func eventKinds(t *testing.T, s *Store, board string) []string {
	t.Helper()
	win, err := s.GoalEventsWindow(context.Background(), []string{board}, 100)
	require.NoError(t, err)
	var kinds []string
	for _, e := range win[board] {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func TestGoalEventsAreWrittenByTheTriggersThatMoveTheCounter(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	str := func(v string) *string { return &v }

	g := newGoal(t, s, "team", "Ship")
	assert.Equal(t, []string{"goal_created"}, eventKinds(t, s, "team"))

	_, err := s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{Title: str("Ship it")})
	require.NoError(t, err)
	_, err = s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{Title: str("Ship it")}) // the same value: not a change, no event, no counter move
	require.NoError(t, err)
	_, err = s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{State: str("blocked"), BlockedOn: str("review")})
	require.NoError(t, err)
	assert.Equal(t, []string{"goal_created", "goal_updated", "goal_updated"}, eventKinds(t, s, "team"), "open to open is an update, and a write that changes nothing writes nothing")

	_, _, err = s.CloseGoal(ctx, "team", g.ID, "done", "")
	require.NoError(t, err)
	_, err = s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{State: str("active")})
	require.NoError(t, err)
	assert.Equal(t, []string{"goal_created", "goal_updated", "goal_updated", "goal_closed", "goal_reopened"}, eventKinds(t, s, "team"))

	task, err := s.CreateTask(ctx, "team", "work", "", "medium", "Lead")
	require.NoError(t, err)
	assert.Len(t, eventKinds(t, s, "team"), 5, "a task with no goal is not a goal event")
	require.NoError(t, s.SetTaskGoal(ctx, "team", task.ID, &g.ID))
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'in_progress' WHERE id = ?`, task.ID)
	require.NoError(t, err)
	g2 := newGoal(t, s, "team", "Other")
	require.NoError(t, s.SetTaskGoal(ctx, "team", task.ID, &g2.ID)) // a move: unlinked from one goal, linked to the other, one change
	require.NoError(t, s.SetTaskGoal(ctx, "team", task.ID, nil))
	got := eventKinds(t, s, "team")
	assert.Equal(t, []string{"goal_created", "goal_updated", "goal_updated", "goal_closed", "goal_reopened", "task_linked", "task_state", "goal_created", "task_unlinked", "task_linked", "task_unlinked"}, got)

	other, err := s.CreateTask(ctx, "team", "doomed", "", "medium", "Lead")
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", other.ID, &g.ID))
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_tasks WHERE id = ?`, other.ID)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_goals WHERE id = ?`, g2.ID)
	require.NoError(t, err)
	got = eventKinds(t, s, "team")
	assert.Equal(t, []string{"task_linked", "task_unlinked", "goal_deleted"}, got[len(got)-3:], "a deleted task and a deleted goal are events too")

	// Every event carries ids and a kind only, the counter value its change gave, and nothing of the goal's text.
	win, err := s.GoalEventsWindow(ctx, []string{"team"}, 100)
	require.NoError(t, err)
	for _, e := range win["team"] {
		assert.NotZero(t, e.Goal)
		assert.NotZero(t, e.Seq)
		assert.Equal(t, "team", e.Board)
	}
	last := win["team"][len(win["team"])-1]
	assert.Equal(t, goalSeq(t, s, "team"), last.Seq, "the last event is the board's current counter")
	// the move (unlinked and linked in one change) shares one counter value
	var moved []GoalEvent
	for _, e := range win["team"] {
		if e.Goal == g2.ID || e.Goal == g.ID {
			if e.Kind == "task_unlinked" || e.Kind == "task_linked" {
				moved = append(moved, e)
			}
		}
	}
	require.GreaterOrEqual(t, len(moved), 3)
}

func TestGoalEventsWindowIsTheNewestPerBoardInOrder(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	str := func(v string) *string { return &v }
	g := newGoal(t, s, "team", "Ship")
	other := newGoal(t, s, "other", "Elsewhere")
	for i := 0; i < 60; i++ {
		_, err := s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{Title: str("Ship " + itoaGoal(i))})
		require.NoError(t, err)
	}
	win, err := s.GoalEventsWindow(ctx, []string{"team", "other"}, 51)
	require.NoError(t, err)
	require.Len(t, win["team"], 51, "the newest 51 of 61")
	for i := 1; i < len(win["team"]); i++ {
		assert.Equal(t, win["team"][i-1].Seq+1, win["team"][i].Seq, "ascending, one counter step apart")
	}
	assert.Equal(t, goalSeq(t, s, "team"), win["team"][50].Seq)
	require.Len(t, win["other"], 1)
	assert.Equal(t, other.ID, win["other"][0].Goal, "a board's events are its own")
	none, err := s.GoalEventsWindow(ctx, nil, 51)
	require.NoError(t, err)
	assert.Empty(t, none)
}

func TestPruneGoalEventsKeepsTheNewestPerBoard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	str := func(v string) *string { return &v }
	g := newGoal(t, s, "team", "Ship")
	o := newGoal(t, s, "other", "Elsewhere")
	for i := 0; i < 9; i++ {
		_, err := s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{Title: str("T" + itoaGoal(i))})
		require.NoError(t, err)
	}
	_, err := s.UpdateGoal(ctx, "other", o.ID, GoalUpdate{Title: str("O")})
	require.NoError(t, err)
	n, err := s.PruneGoalEvents(ctx, 4)
	require.NoError(t, err)
	assert.EqualValues(t, 6, n, "team had 10 events and keeps 4; other had 2 and keeps both")
	win, err := s.GoalEventsWindow(ctx, []string{"team", "other"}, 100)
	require.NoError(t, err)
	require.Len(t, win["team"], 4)
	assert.Equal(t, goalSeq(t, s, "team"), win["team"][3].Seq, "the newest are the ones kept")
	assert.Len(t, win["other"], 2)
	n, err = s.PruneGoalEvents(ctx, 4)
	require.NoError(t, err)
	assert.Zero(t, n, "nothing more to prune")
	_, err = s.PruneGoalEvents(ctx, 0)
	assert.Error(t, err, "keeping none is refused")
}

// A database from before the events (its triggers move the counter and write nothing else) gets the new triggers when the schema is ensured, and the events start from then on; the counter it already had is
// kept, so a connection that saw it is told "gap" (the feed's rule), never a wrong event.
func TestGoalEventsTriggersReplaceTheOlderOnesAndKeepTheCounter(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Before")
	before := goalSeq(t, s, "team")
	for _, ddl := range []string{
		`DROP TRIGGER board_goals_seq_insert`,
		`CREATE TRIGGER board_goals_seq_insert AFTER INSERT ON board_goals BEGIN INSERT INTO board_goal_meta (board_id, seq, updated_at) VALUES (NEW.board_id, 1, 'x') ON CONFLICT(board_id) DO UPDATE SET seq = seq + 1; END`,
		`DELETE FROM board_goal_events`,
	} {
		_, err := s.db.ExecContext(ctx, ddl)
		require.NoError(t, err, ddl)
	}
	_ = newGoal(t, s, "team", "Older trigger")
	assert.Empty(t, eventKinds(t, s, "team"), "the older trigger writes no event")
	require.NoError(t, s.ensureGoalsSchema(ctx))
	require.Equal(t, before+1, goalSeq(t, s, "team"), "the counter is kept")
	_ = newGoal(t, s, "team", "New trigger")
	assert.Equal(t, []string{"goal_created"}, eventKinds(t, s, "team"), "events start with the new triggers")
	win, err := s.GoalEventsWindow(ctx, []string{"team"}, 10)
	require.NoError(t, err)
	assert.Equal(t, before+2, win["team"][0].Seq, "the first event is not the one right above a counter seen before it: the feed reads that as a gap")
	_ = g
}
