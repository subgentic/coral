package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21697: while a task waits on a member the owner gets no no-activity nudge for it.
func TestNoStatusNudgeWhileTheTaskWaitsOnAMember(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	sid := "88888888-8888-8888-8888-888888888888"
	n.agent("Dev", sid)
	task, err := n.bs.CreateTask(ctx, "team", "work", "", "high", "Operator", "Dev")
	require.NoError(t, err)
	_, err = n.bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	n.sig[sid] = agentSignal{Since: n.now, LastEvent: n.now}
	_, err = n.bs.SetTaskWaitOn(ctx, "team", task.ID, board.TaskWaitOn{Member: "Orchestrator", Reason: "need a decision", SetBy: "Dev"})
	require.NoError(t, err)
	n.run(40 * time.Minute)
	assert.Empty(t, n.sentTo("Dev"), "waiting on a member: not a stall")
}

// #21697: the check of the member waited on has the line, and a stalled in_progress task is not counted as working.
func TestCheckNamesTheWaitAndTheStalledTask(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	task, err := h.s.CreateTask(ctx, "team", "billing", "", "high", "Operator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	stalled, err := h.s.CreateTask(ctx, "team", "silent", "", "high", "Operator", "QA")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "QA", stalled.ID)
	require.NoError(t, err)
	h.now = h.now.Add(6 * time.Hour)
	h.member("Dev", "Developer", 2, 6*time.Hour)
	h.member("QA", "QA Engineer", 3, 6*time.Hour)
	// QA's last tool activity is also long ago: no LastEvent set. Dev waits on the Orchestrator.
	_, err = h.s.SetTaskWaitOn(ctx, "team", task.ID, board.TaskWaitOn{Member: "Orchestrator", Reason: "need the API choice", SetBy: "Dev"})
	require.NoError(t, err)
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, "Dev's #")
	assert.Contains(t, out, `on you: "need the API choice"`)
	assert.Contains(t, out, "QA's #")
	assert.Contains(t, out, "stalled", "an in-progress task with no activity and no wait-on is stalled")
	assert.NotContains(t, out, fmt.Sprintf("Dev's #%d is in progress with no activity", task.ID), "a waiting task is not stalled")
}
