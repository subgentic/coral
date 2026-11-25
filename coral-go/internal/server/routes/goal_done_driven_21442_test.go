package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	setreg "github.com/subgentic/coral/internal/settings"
)

// #21442 (Operator 11-25: "way too many goal looks done messages ... often when the goal is not finished"): a goal that has a driver (an active member, or the team's Orchestrator when it has none) is never a "Goal looks
// done" item of Needs you; its driver is told, as before. A goal with no driver shows it at most once; one that is reopened and done again shows nothing a second time. A setting brings today's behaviour back.
type goalDoneRig struct {
	t        *testing.T
	h        *BoardHandler
	bs       *board.Store
	settings map[string]string
}

func newGoalDoneRig(t *testing.T) *goalDoneRig {
	h, bs := operatorAsksRig(t)
	rig := &goalDoneRig{t: t, h: h, bs: bs, settings: map[string]string{}}
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-dev", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err)
	h.goalDoneNow = quietPassed
	h.SetInboxSettings(func(context.Context) (map[string]string, error) { return rig.settings, nil })
	h.SetGoalDoneEdit(func(_ context.Context, key string, max int, edit func([]string) []string) ([]string, error) {
		var list []string
		_ = json.Unmarshal([]byte(rig.settings[key]), &list)
		list = edit(list)
		b, _ := json.Marshal(list)
		rig.settings[key] = string(b)
		return list, nil
	})
	return rig
}

func (g *goalDoneRig) goal(title, driver string) *board.Goal {
	gl, err := g.bs.CreateGoal(context.Background(), "team", board.GoalInput{Title: title, CreatedBy: "Lead", Driver: driver})
	require.NoError(g.t, err)
	return gl
}

func (g *goalDoneRig) finishTask(gl *board.Goal) {
	ctx := context.Background()
	tk, err := g.bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &gl.ID})
	require.NoError(g.t, err)
	_, err = g.bs.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(g.t, err)
	_, err = g.bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(g.t, err)
}

func (g *goalDoneRig) items() []string {
	code, out := readNeedsYou(g.t, g.h, "", asPerson)
	require.Equal(g.t, http.StatusOK, code, out)
	var got []string
	for _, it := range needsYouItems(out) {
		if it["kind"] == "goal_done" {
			got = append(got, it["id"].(string))
		}
	}
	return got
}

func TestADrivenGoalIsNeverALooksDoneItem(t *testing.T) {
	g := newGoalDoneRig(t)
	driven := g.goal("Has a driver", "Dev")
	g.finishTask(driven)
	assert.Empty(t, g.items(), "a goal whose driver is an active member is not put in front of the Operator")
	orchDriven := g.goal("Orchestrator's by default", "") // no driver set: the team's Orchestrator is told, so it has one
	g.finishTask(orchDriven)
	assert.Empty(t, g.items(), "a goal with no driver of its own still has the team's Orchestrator")
	_, err := g.bs.Unsubscribe(context.Background(), "team", "Lead")
	require.NoError(t, err)
	assert.Equal(t, []string{fmt.Sprintf("goal_done:team:%d", orchDriven.ID)}, g.items(), "with nobody active to drive it, the goal is the Operator's")
}

func TestAGoalWithNoDriverIsAnItemAtMostOnce(t *testing.T) {
	g := newGoalDoneRig(t)
	_, err := g.bs.Unsubscribe(context.Background(), "team", "Lead") // no Orchestrator: nobody drives
	require.NoError(t, err)
	gl := g.goal("Nobody's", "")
	g.finishTask(gl)
	want := []string{fmt.Sprintf("goal_done:team:%d", gl.ID)}
	assert.Equal(t, want, g.items(), "shown once")
	assert.Equal(t, want, g.items(), "and still shown on the next read: it is one item until it is dealt with")
	ctx := context.Background()
	_, _, err = g.bs.CloseGoal(ctx, "team", gl.ID, "shipped", board.GoalDone)
	require.NoError(t, err)
	assert.Empty(t, g.items(), "closed")
	_, err = g.bs.UpdateGoal(ctx, "team", gl.ID, board.GoalUpdate{State: ptrString(board.GoalActive)})
	require.NoError(t, err)
	g.finishTask(gl)
	assert.Empty(t, g.items(), "reopened and done again: it does not show a second time")
}

func TestTheSettingBringsTheDrivenItemsBack(t *testing.T) {
	g := newGoalDoneRig(t)
	driven := g.goal("Has a driver", "Dev")
	g.finishTask(driven)
	assert.Empty(t, g.items())
	g.settings[setreg.GoalDoneDrivenItems] = "true"
	assert.Equal(t, []string{fmt.Sprintf("goal_done:team:%d", driven.ID)}, g.items(), "on: a driven goal is an item again")
	ctx := context.Background()
	_, _, err := g.bs.CloseGoal(ctx, "team", driven.ID, "shipped", board.GoalDone)
	require.NoError(t, err)
	_, err = g.bs.UpdateGoal(ctx, "team", driven.ID, board.GoalUpdate{State: ptrString(board.GoalActive)})
	require.NoError(t, err)
	g.finishTask(driven)
	assert.Len(t, g.items(), 1, "and, as before the change, a goal done again is an item again")
}

func TestTheDrivenSettingIsOffByDefault(t *testing.T) {
	spec, ok := setreg.Lookup(setreg.GoalDoneDrivenItems)
	require.True(t, ok)
	assert.Equal(t, "false", spec.Default)
	assert.False(t, setreg.Bool(map[string]string{}, setreg.GoalDoneDrivenItems))
}
