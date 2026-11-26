package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func expiryTask(t *testing.T, h *checkHarness, owner string) int64 {
	t.Helper()
	ctx := context.Background()
	task, err := h.s.CreateTask(ctx, "team", "held "+owner, "", "high", "Operator", owner)
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", owner, task.ID)
	require.NoError(t, err)
	return task.ID
}

func statusOf(t *testing.T, h *checkHarness, id int64) string {
	t.Helper()
	task, err := h.s.GetTask(context.Background(), "team", id)
	require.NoError(t, err)
	return task.Status
}

// #21700: a claim held by an agent that is asleep (no live session) past claim_expire_hours goes back to pending, still its owner's, and the check names it once.
func TestAClaimHeldByASleepingAgentGoesBackToPending(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	_, err := h.s.Subscribe(ctx, "team", "Sleeper", "Developer", "claude-sleeper", nil, "all") // no live agent: asleep
	require.NoError(t, err)
	id := expiryTask(t, h, "Sleeper")
	h.now = h.now.Add(80 * time.Hour)
	out := h.checkTo("Orchestrator")
	assert.Equal(t, "pending", statusOf(t, h, id))
	task, _ := h.s.GetTask(ctx, "team", id)
	require.NotNil(t, task.AssignedTo)
	assert.Equal(t, "Sleeper", *task.AssignedTo)
	assert.Contains(t, out, "Sleeper's #")
	assert.Contains(t, out, "went back to pending")
}

// #21700: a task waiting on a member (#21697), a task whose owner is in a turn, and a team with the setting off are all left alone.
func TestClaimExpiryExemptions(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	for _, n := range []string{"Waiter", "Busy"} {
		_, err := h.s.Subscribe(ctx, "team", n, "Developer", "claude-"+n, nil, "all")
		require.NoError(t, err)
	}
	waiting := expiryTask(t, h, "Waiter")
	busy := expiryTask(t, h, "Busy")
	_, err := h.s.SetTaskWaitOn(ctx, "team", waiting, board.TaskWaitOn{Member: "Orchestrator", Reason: "need a decision", SetBy: "Waiter"})
	require.NoError(t, err)
	h.now = h.now.Add(80 * time.Hour)
	h.member("Busy", "Developer", 5, 0) // in a turn now
	h.checkTo("Orchestrator")
	assert.Equal(t, "in_progress", statusOf(t, h, waiting), "waiting on a member: exempt")
	assert.Equal(t, "in_progress", statusOf(t, h, busy), "its owner is working right now")

	// The setting off: an old claim of a sleeping agent stays.
	_, err = h.s.Subscribe(ctx, "team", "Late", "Developer", "claude-Late", nil, "all")
	require.NoError(t, err)
	late := expiryTask(t, h, "Late")
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.ClaimExpireHours = 0
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	h.now = h.now.Add(200 * time.Hour)
	h.m.scan(ctx)
	assert.Equal(t, "in_progress", statusOf(t, h, late), "setting off")
}
