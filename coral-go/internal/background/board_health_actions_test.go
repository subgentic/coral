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
)

// Rule 2 (#11729): a wait is a line when it is older than the threshold and its target has posted nothing since; once the target posts, the wait is being served and the line goes.
func TestActionListStuckWaitFollowsTheTargetsPosts(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Security Reviewer", "Security", 2, 0)
	h.member("Frontend Dev", "Frontend Dev", 3, 0)
	h.wait(3, "Frontend Dev", "message", "Security Reviewer")
	h.now = time.Now().UTC().Add(20 * time.Minute)
	out := h.check()
	assert.Contains(t, out, "Frontend Dev has waited 20 min on Security Reviewer; Security Reviewer has posted nothing since.")
	time.Sleep(1100 * time.Millisecond) // sleep-ok: message times have a one second resolution, and the post must be after the wait began
	_, err := h.s.PostMessage(ctx, "team", "Security Reviewer", "working on it", nil)
	require.NoError(t, err)
	out = h.check()
	assert.NotContains(t, out, "has waited", "Security Reviewer has posted since: the wait is being served")
}

// Rule 7: what waits on the recipient is first, with the waiter's last message number to answer; a task wait says which task.
func TestActionListWaitOnTheOrchestratorNamesTheWaitersLastMessage(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	posted, err := h.s.PostMessage(ctx, "team", "Dev", "ready for review?", nil)
	require.NoError(t, err)
	h.wait(2, "Dev", "message", "Orchestrator")
	out := h.check()
	assert.Contains(t, out, "Dev has waited ")
	assert.Contains(t, out, fmt.Sprintf("on YOU (their last message is #%d). Answer them.", posted.ID))
	assert.Less(t, strings.Index(out, "Orchestrator, act on these"), strings.Index(out, "Dev has waited"))
}

// Rule 5: more than K open tasks on one agent while an agent sleeps (K and the sleepers are settings, 5 and 1 by default).
func TestActionListOverloadedAgentWhileAnotherSleeps(t *testing.T) {
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
	out := h.check()
	assert.Contains(t, out, "Busy Dev holds 6 open tasks while 1 agent sleeps. Reassign some, or wake a sleeper.")
	hs := healthOn()
	hs.ActionList.OverloadedTasks = 6 // not more than 6
	_, err := h.s.UpdateBoardSettings(ctx, "team", board.BoardSettingsUpdate{Health: &hs})
	require.NoError(t, err)
	assert.NotContains(t, h.check(), "holds", "the threshold is the team's setting")
}
