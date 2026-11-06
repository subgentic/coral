package routes

import (
	"context"
	"strconv"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13834: the done-state route. The Operator's Not yet, Dismiss, Undo and Mark read or unread on a "Goal looks done" row, as a word; the server builds the saved entry itself from the goal it loads on the path's board.

type listStore struct {
	mu    sync.Mutex
	lists map[string][]string
	max   map[string]int
}

func (l *listStore) edit(_ context.Context, key string, max int, edit func([]string) []string) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lists == nil {
		l.lists, l.max = map[string][]string{}, map[string]int{}
	}
	out := edit(append([]string(nil), l.lists[key]...))
	if max > 0 && len(out) > max {
		out = out[len(out)-max:]
	}
	l.lists[key], l.max[key] = out, max
	return out, nil
}

func (l *listStore) get(key string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lists[key]...)
}

// doneGoal is a goal on alpha with one finished task.
func (g *goalOpRig) doneGoal() *board.Goal {
	gl := g.goal("alpha", "Lead")
	ctx := context.Background()
	tk, err := g.bs.CreateTaskWithOpts(ctx, "alpha", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &gl.ID})
	require.NoError(g.t, err)
	_, err = g.bs.ClaimTask(ctx, "alpha", "Dev", tk.ID)
	require.NoError(g.t, err)
	_, err = g.bs.CompleteTask(ctx, "alpha", tk.ID, "Dev", nil)
	require.NoError(g.t, err)
	gl, err = g.bs.GetGoal(ctx, "alpha", gl.ID)
	require.NoError(g.t, err)
	require.Equal(g.t, 1, gl.Rollup.Total)
	return gl
}

func TestTheOwnersDoneStateWritesTheEntryTheServerBuildsAndUndoTakesItBack(t *testing.T) {
	g := newGoalOpRig(t)
	ls := &listStore{}
	g.h.SetGoalDoneEdit(ls.edit)
	gl := g.doneGoal()
	id := strconv.FormatInt(gl.ID, 10)

	code, out := g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "not_yet"})
	require.Equal(t, 200, code, out)
	assert.Equal(t, []string{"alpha|" + id + "|1"}, ls.get("goal_done_hidden"), "Not yet: the goal at its all-done total")
	code, _ = g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "dismiss"})
	require.Equal(t, 200, code)
	assert.Equal(t, []string{"alpha|" + id + "|1", "alpha|" + id + "|*"}, ls.get("goal_done_hidden"))
	code, _ = g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "dismiss"})
	require.Equal(t, 200, code)
	assert.Len(t, ls.get("goal_done_hidden"), 2, "pressing it again does not add it twice")
	code, _ = g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "show"})
	require.Equal(t, 200, code)
	assert.Empty(t, ls.get("goal_done_hidden"), "Undo takes every hiding entry of the goal")

	code, _ = g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "read"})
	require.Equal(t, 200, code)
	assert.Equal(t, []string{"alpha|" + id + "|1|" + gl.UpdatedAt}, ls.get("goal_done_read"), "read: the total and the goal's last change")
	code, _ = g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "unread"})
	require.Equal(t, 200, code)
	assert.Empty(t, ls.get("goal_done_read"))
	assert.Equal(t, goalDoneHiddenMax, ls.max["goal_done_read"], "the list is capped at what the Inbox reads")
}

func TestADoneStateThatHidesTheRowRemovesItFromNeedsYou(t *testing.T) {
	g := newGoalOpRig(t)
	ls := &listStore{}
	g.h.SetGoalDoneEdit(ls.edit)
	g.h.SetGoalDoneHidden(func(context.Context) []string { return ls.get("goal_done_hidden") })
	g.h.SetGoalDoneRead(func(context.Context) []string { return ls.get("goal_done_read") })
	g.h.goalDoneNow = quietPassed
	gl := g.doneGoal()
	items := func() int {
		its, err := g.h.goalDoneItems(context.Background(), "alpha", g.h.goalDoneHiddenSet(context.Background()), g.h.goalDoneReadSet(context.Background()), nil)
		require.NoError(t, err)
		return len(its)
	}
	require.Equal(t, 1, items())
	for _, st := range []string{"not_yet", "dismiss"} {
		g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": st})
		assert.Equal(t, 0, items(), st+" hides it")
		g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "show"})
		assert.Equal(t, 1, items(), "Undo brings it back")
	}
	g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "read"})
	assert.Equal(t, 0, items(), "read stops counting")
	g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "unread"})
	assert.Equal(t, 1, items())
}

// Security's MUST A: the entry's team and goal come from the server, the goal must be on the path's board, an unknown state writes nothing, and nothing but the state is read.
func TestTheDoneStateTakesNothingFromTheRequestButTheWord(t *testing.T) {
	g := newGoalOpRig(t)
	ls := &listStore{}
	g.h.SetGoalDoneEdit(ls.edit)
	gl := g.doneGoal()
	for name, body := range map[string]any{
		"unknown state": map[string]any{"state": "delete"}, "empty": map[string]any{}, "upper case": map[string]any{"state": "DISMISS"},
		"a team of the caller's": map[string]any{"state": "dismiss", "team": "beta"}, "an entry of the caller's": map[string]any{"state": "dismiss", "entry": "x|1|*"},
		"state not a string": map[string]any{"state": 3},
	} {
		code, _ := g.call("person", "alpha", gl.ID, "done-state", body)
		assert.Equal(t, 400, code, name)
	}
	code, _ := g.call("person", "beta", gl.ID, "done-state", map[string]any{"state": "dismiss"})
	assert.Equal(t, 404, code, "a goal of another board")
	code, _ = g.call("person", "alpha", gl.ID+999, "done-state", map[string]any{"state": "dismiss"})
	assert.Equal(t, 404, code, "no such goal")
	assert.Empty(t, ls.get("goal_done_hidden"), "none of those wrote anything")
	assert.Empty(t, ls.get("goal_done_read"))
}

func TestOnlyThePersonMayChangeAGoalsDoneState(t *testing.T) {
	g := newGoalOpRig(t)
	ls := &listStore{}
	g.h.SetGoalDoneEdit(ls.edit)
	gl := g.doneGoal()
	for _, who := range []string{"agent", "key", ""} {
		code, _ := g.call(who, "alpha", gl.ID, "done-state", map[string]any{"state": "dismiss"})
		assert.Equal(t, 403, code, who)
	}
	code, _ := g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "dismiss"}, tunnel.ViaHeader, "1")
	assert.Equal(t, 403, code, "a Hub grantee")
	assert.Empty(t, ls.get("goal_done_hidden"))
}

func TestADoneStateWithoutAnOpenBoardAnswers503(t *testing.T) {
	g := newGoalOpRig(t)
	gl := g.doneGoal() // no editor set
	code, _ := g.call("person", "alpha", gl.ID, "done-state", map[string]any{"state": "dismiss"})
	assert.Equal(t, 503, code)
}
