package background

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/teamhealth"
)

// #21702 (coral-hub's audit): a line of the roster's own rules carries an ack id, and acknowledging it takes it off until it changes. The overloaded-member line had none and came back at every check.
func TestTheOverloadedLineHasAnAckIdAndAnAckKeepsItOff(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Busy Dev", "Developer", 2, 0)
	h.member("Sleeper", "Developer", 3, 0)
	h.sleeping(3)
	for i := 0; i < 6; i++ {
		_, err := h.s.CreateTask(ctx, "team", fmt.Sprintf("task %d", i), "", "medium", "Operator", "Busy Dev")
		require.NoError(t, err)
	}
	id := teamhealth.ItemID("overload|Busy Dev")
	assert.Contains(t, h.check(), "[ack "+id+"] Busy Dev holds 6 open tasks while 1 agent sleeps.", "every item has an ack id")
	require.NoError(t, h.s.AckHealthItem(ctx, "team", id, "Orchestrator", h.now))
	assert.NotContains(t, h.check(), "Busy Dev holds", "acknowledged: off while it is the same")
	_, err := h.s.CreateTask(ctx, "team", "one more", "", "medium", "Operator", "Busy Dev")
	require.NoError(t, err)
	assert.Contains(t, h.check(), "Busy Dev holds 7 open tasks", "its count changed: it is back")
}

// The ack id is on the goal's reminder too, and an acknowledged READY is not repeated every check.
func TestAReadyGoalHasAnAckIdAndAnAckStopsTheReminder(t *testing.T) {
	r := newGoalsRig(t)
	g := r.goalDone("Release 2.1.1", 2)
	seg := goalsSegment(r.next())
	id := teamhealth.ItemID(fmt.Sprintf("goal|%d|close", g))
	assert.Contains(t, seg, "READY [ack "+id+"]")
	require.NoError(t, r.s.AckHealthItem(context.Background(), "team", id, "Orchestrator", r.now))
	seg = goalsSegment(r.next())
	assert.Contains(t, seg, fmt.Sprintf("#%d", g), "still an open goal")
	assert.NotContains(t, seg, "READY", "acknowledged: not repeated")
}
