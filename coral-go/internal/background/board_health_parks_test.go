package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11660: the orchestrator's check names an agent that holds a park older than a day, or more parks than the cap (parks made before the cap are reported, never touched). A park under a day old, and an
// unassigned one, say nothing; the line holds numbers, never the reason.
func TestTheCheckNamesAnAgentWithAParkOverADayOrOverTheCap(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	mk := func(title, who string) int64 {
		task, err := h.s.CreateTask(ctx, "team", title, "", "medium", "Orchestrator", who)
		require.NoError(t, err)
		return task.ID
	}
	items := func(at time.Time) []string {
		all, err := h.s.ListOpenTaskStates(ctx, "team")
		require.NoError(t, err)
		var out []string
		for _, it := range h.m.parkItems(ctx, "team", all, at) {
			assert.Equal(t, "Dev", it.Agent)
			assert.Contains(t, it.Suggest, "coral-board task release")
			assert.NotContains(t, it.Problem+it.Suggest, "secret", "numbers only, never the reason")
			out = append(out, it.Problem)
		}
		return out
	}
	parked, loose := mk("Parked", "Dev"), mk("Loose", "")
	_, err := h.s.ParkTask(ctx, "team", parked, "secret reason about the billing team", time.Time{})
	require.NoError(t, err)
	_, err = h.s.ParkTask(ctx, "team", loose, "unassigned park", time.Time{})
	require.NoError(t, err)

	assert.Empty(t, items(time.Now().UTC().Add(2*time.Hour)), "a park two hours old says nothing")
	assert.Equal(t, []string{fmt.Sprintf("has #%d parked over 24 h", parked)}, items(time.Now().UTC().Add(30*time.Hour)), "an unassigned park has no agent to name")

	// Over the cap (parks made before it, here moved to one owner): reported, and the parks are untouched.
	ids := []int64{parked}
	for _, title := range []string{"A", "B"} {
		id := mk(title, "Orchestrator")
		_, err = h.s.ParkTask(ctx, "team", id, "an old park", time.Time{})
		require.NoError(t, err)
		_, err = h.s.ReassignTask(ctx, "team", id, "Dev")
		require.NoError(t, err)
		ids = append(ids, id)
	}
	assert.Equal(t, []string{"holds 3 parked tasks (at most 2): #" + fmt.Sprint(ids[0]) + ", #" + fmt.Sprint(ids[1]) + ", #" + fmt.Sprint(ids[2])}, items(time.Now().UTC().Add(time.Hour)))
	for _, id := range ids {
		task, _ := h.s.GetTask(ctx, "team", id)
		assert.True(t, task.Parked(time.Now()), "#%d is still parked", id)
	}

	// It reaches the orchestrator's check.
	h.now = time.Now().UTC().Add(30 * time.Hour)
	assert.Contains(t, h.checkTo("Orchestrator"), "Dev: holds 3 parked tasks (at most 2), #")
}
