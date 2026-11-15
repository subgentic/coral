package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17648: a High task that waits behind its owner's lower-priority work for over 30 minutes is named in the orchestrator's check, with the suggestion to switch or reassign. Equal or higher work in hand,
// a High that is not yet 30 minutes old, a Low waiting behind a Medium and a task nobody owns say nothing.
func TestTheCheckNamesAHighTaskWaitingBehindLowerPriorityWork(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("Dev2", "Developer", 3, 0)
	mk := func(title, prio, who string) int64 {
		task, err := h.s.CreateTask(ctx, "team", title, "", prio, "Orchestrator", who)
		require.NoError(t, err)
		return task.ID
	}
	items := func(at time.Time) []string {
		all, err := h.s.ListOpenTaskStates(ctx, "team")
		require.NoError(t, err)
		var out []string
		for _, it := range priorityWaitItems(all, at) {
			assert.Equal(t, "Dev", it.Agent)
			assert.Contains(t, it.Suggest, "switch")
			assert.Contains(t, it.Suggest, "reassign")
			out = append(out, it.Problem)
		}
		return out
	}
	medium := mk("Medium work", "medium", "Dev")
	_, err := h.s.ClaimTask(ctx, "team", "Dev", medium)
	require.NoError(t, err)
	high := mk("High work", "high", "Dev")
	_ = mk("Low behind medium", "low", "Dev")        // lower than what it is doing: not waiting behind lower-priority work
	_ = mk("Unowned high", "high", "")               // nobody to switch
	equal := mk("Other medium", "medium", "Dev2")     // Dev2: medium in hand, a medium waiting
	_, err = h.s.ClaimTask(ctx, "team", "Dev2", equal)
	require.NoError(t, err)
	_ = mk("Second medium", "medium", "Dev2")

	assert.Empty(t, items(time.Now().UTC().Add(10*time.Minute)), "a High under 30 minutes old says nothing")
	want := fmt.Sprintf("has High #%d waiting while working on lower-priority #%d for over 30 min", high, medium)
	assert.Equal(t, []string{want}, items(time.Now().UTC().Add(45*time.Minute)))

	// It reaches the orchestrator's check.
	h.now = time.Now().UTC().Add(45 * time.Minute)
	assert.Contains(t, h.checkTo("Orchestrator"), "Dev: "+want)
}
