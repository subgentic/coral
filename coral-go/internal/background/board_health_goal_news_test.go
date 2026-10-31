package background

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

func TestAGoalThatNeedsTheOperatorIsNewsOnceThenOnlyTheHeartbeat(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Worker", "Developer", 2, 0)
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.IntervalMin, hs.HeartbeatMin, hs.AllClear = 10, 60, true
	hs.BusyNoTask.On = false
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	sent := func() []string {
		h.mu.Lock()
		defer h.mu.Unlock()
		return append([]string(nil), h.sent["Orchestrator"]...)
	}
	start := h.now
	at := func(min int) int {
		h.now = start.Add(time.Duration(min) * time.Minute)
		h.m.scan(ctx)
		return len(sent())
	}
	assert.Equal(t, 1, at(0), "the first look says so")
	assert.Equal(t, 1, at(10))
	g, err := h.s.CreateGoal(ctx, "team", board.GoalInput{Title: "Needs a pick", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	_, err = h.s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &g.ID}, "Worker")
	require.NoError(t, err)
	st, on := board.GoalBlocked, "Operator picks an option"
	_, err = h.s.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{State: &st, BlockedOn: &on})
	require.NoError(t, err)
	assert.Equal(t, 2, at(20), "a goal that now needs the operator is news at the next look, not at the heartbeat")
	require.Contains(t, sent()[1], "NEEDS THE OPERATOR")
	for _, m := range []int{30, 40, 50, 60, 70} {
		assert.Equal(t, 2, at(m), "minute %d: the same reminder is not said again before the heartbeat", m)
	}
	assert.Equal(t, 3, at(80), "the heartbeat, an hour after the last check, repeats it")
	assert.True(t, strings.Contains(sent()[2], "NEEDS THE OPERATOR"))
}
