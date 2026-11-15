package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/subgentic/coral/internal/board"
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
	_ = mk("Low behind medium", "low", "Dev")     // lower than what it is doing: not waiting behind lower-priority work
	_ = mk("Unowned high", "high", "")            // nobody to switch
	equal := mk("Other medium", "medium", "Dev2") // Dev2: medium in hand, a medium waiting
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

// #18095: an edit to the waiting High task (its UpdatedAt moves) does not restart the 30 minutes: it counts from when it was filed.
func TestAnEditToTheWaitingTaskDoesNotHideTheStall(t *testing.T) {
	now := time.Now().UTC()
	at := func(ago time.Duration) string { return now.Add(-ago).Format(time.RFC3339Nano) }
	dev := "Dev"
	claimed := at(3 * time.Hour)
	tasks := []board.Task{
		{ID: 1, Status: "in_progress", Priority: "medium", AssignedTo: &dev, CreatedAt: at(4 * time.Hour), ClaimedAt: &claimed, UpdatedAt: at(time.Hour)},
		{ID: 2, Status: "pending", Priority: "high", AssignedTo: &dev, CreatedAt: at(2 * time.Hour), UpdatedAt: at(2 * time.Minute)}, // edited two minutes ago
	}
	got := priorityWaitItems(tasks, now)
	require.Len(t, got, 1, "the edit did not make the High task look new")
	assert.Contains(t, got[0].Problem, "High #2")
	assert.GreaterOrEqual(t, got[0].Age, 2*time.Hour-time.Minute, "its age is from when it was filed")
}
