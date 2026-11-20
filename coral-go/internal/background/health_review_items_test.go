package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
)

func reviewTask(t *testing.T, h *checkHarness, parent int64, round int, who string) *board.Task {
	t.Helper()
	rt, err := h.s.CreateTaskWithOpts(context.Background(), "team", "Review #1: a title", "", "high", "Orchestrator", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ReviewOf: parent, ReviewRound: round}}, who)
	require.NoError(t, err)
	return rt
}

// #19910 (the Operator: "let's coral nudge the orchestrator to do it"): a review waiting 20+ minutes with its reviewer idle at the prompt is an item in the orchestrator's check, for every team.
func TestAReviewWaitingWithAnIdleReviewerIsAnItemForTheOrchestrator(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 2*time.Hour)
	h.member("QA", "QA Engineer", 2, 45*time.Minute)
	parent, err := h.s.CreateTask(ctx, "team", "parent", "", "high", "Operator")
	require.NoError(t, err)
	rt := reviewTask(t, h, parent.ID, 3, "QA")
	other := reviewTask(t, h, parent.ID, 3, "QA") // a second review for the same reviewer: still one item

	assert.NotContains(t, h.checkTo("Orchestrator"), "reviewer idle", "a review that has waited a minute is not late")
	h.now = h.now.Add(25 * time.Minute)
	h.sig[fmt.Sprintf("%08d-0000-0000-0000-000000000000", 2)] = agentSignal{Since: h.now.Add(-70 * time.Minute)}
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, fmt.Sprintf("QA: #%d (review of #%d, round 3) waiting", rt.ID, parent.ID))
	assert.Contains(t, out, ", reviewer idle")
	assert.Contains(t, out, "peek it and post to it directly")
	assert.Equal(t, 1, strings.Count(out, "reviewer idle"), "one item per reviewer, naming the longest waiting: %s (the other is #%d)", out, other.ID)
	assert.NotContains(t, out, "a title", "numbers only: no task title is posted")
}

// Not an item: a reviewer in a turn, one at work on a review it claimed this minute, or a review that is young. A reviewer parked in `coral-board wait` since before the review reads as in a
// turn for ever (its tool call has no end), and is idle for this item: it is exactly QA Reviewer 2 on 2026-11-19.
func TestAnIdleReviewItemFollowsTheReviewersState(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 2*time.Hour)
	h.member("Busy", "QA Engineer", 2, 0) // in a turn
	h.member("Parked", "QA Engineer", 3, 0)
	parent, err := h.s.CreateTask(ctx, "team", "parent", "", "high", "Operator")
	require.NoError(t, err)
	reviewTask(t, h, parent.ID, 1, "Busy")
	_, err = h.s.RegisterWait(ctx, "team", "Parked", naming.SessionName("claude", fmt.Sprintf("%08d-0000-0000-0000-000000000000", 3)), "task", "999", "", 6*time.Hour)
	require.NoError(t, err)
	time.Sleep(1100 * time.Millisecond)
	reviewTask(t, h, parent.ID, 2, "Parked")
	h.now = h.now.Add(25 * time.Minute)
	h.sig[fmt.Sprintf("%08d-0000-0000-0000-000000000000", 2)] = agentSignal{InTurn: true, Since: h.now.Add(-25 * time.Minute)}
	h.sig[fmt.Sprintf("%08d-0000-0000-0000-000000000000", 3)] = agentSignal{InTurn: true, Since: h.now.Add(-80 * time.Minute)}
	out := h.checkTo("Orchestrator")
	assert.NotContains(t, out, "Busy: #", "a reviewer in a turn is working")
	assert.Contains(t, out, "Parked: #", "a reviewer parked in a wait older than the review is idle")
	assert.NotContains(t, out, "Orchestrator: #")
}
