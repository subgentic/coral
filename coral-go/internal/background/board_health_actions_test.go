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

// Rule 2 (#11729): a wait is a line when it is older than the threshold and its target has not mentioned the waiter since; the target's other posts do not serve it (Security's INFO), a
// post that mentions the waiter does, and so does finishing the task the wait is on.
func TestActionListStuckWaitIsServedByAMentionOrTheTaskDone(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Security Reviewer", "Security", 2, 0)
	h.member("Frontend Dev", "Frontend Dev", 3, 0)
	h.wait(3, "Frontend Dev", "message", "Security Reviewer")
	h.now = time.Now().UTC().Add(20 * time.Minute)
	out := h.check()
	assert.Contains(t, out, "Frontend Dev has waited 20 min on Security Reviewer; Security Reviewer has not mentioned them since.")
	time.Sleep(1100 * time.Millisecond) // sleep-ok: message times have a one second resolution, and the post must be after the wait began
	_, err := h.s.PostMessage(ctx, "team", "Security Reviewer", "working on something else, and @Orchestrator is told", nil)
	require.NoError(t, err)
	assert.Contains(t, h.check(), "Security Reviewer has not mentioned them since.", "a post that mentions someone else does not serve the wait")
	_, err = h.s.PostMessage(ctx, "team", "Security Reviewer", "@Frontend Dev here is the answer", nil)
	require.NoError(t, err)
	out = h.check()
	assert.NotContains(t, out, "has not mentioned them since", "a post that mentions the waiter serves it")
	assert.Contains(t, out, "although Security Reviewer has posted a message mentioning them since: check Frontend Dev.", "and a waiter that has not woken is said so")
}

func TestActionListTaskWaitIsServedWhenTheTaskIsDone(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Security Reviewer", "Security", 2, 0)
	h.member("Dev", "Developer", 3, 0)
	task, err := h.s.CreateTask(ctx, "team", "owned", "", "medium", "Operator", "Security Reviewer")
	require.NoError(t, err)
	h.wait(3, "Dev", "task", fmt.Sprint(task.ID))
	h.now = time.Now().UTC().Add(20 * time.Minute)
	out := h.check()
	assert.Contains(t, out, fmt.Sprintf("Dev has waited 20 min on Security Reviewer; Security Reviewer has not mentioned them since and the task is not done"), out)
	_, err = h.s.ClaimTask(ctx, "team", "Security Reviewer", task.ID)
	require.NoError(t, err)
	_, err = h.s.CompleteTask(ctx, "team", task.ID, "Security Reviewer", nil)
	require.NoError(t, err)
	assert.NotContains(t, h.check(), "Dev has waited", "the task is done: the wait is served")
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

// Rule 4: posts that @-address a part of a member's name while no mention has reached it are a line; one proper mention clears it.
func TestActionListMentionsThatDoNotReachAMember(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Backend Dev", "Backend Developer", 2, 0)
	for _, text := range []string{"@Backend please look at #12", "@backend any news?"} {
		_, err := h.s.PostMessage(ctx, "team", "Orchestrator", text, nil)
		require.NoError(t, err)
	}
	out := h.check()
	assert.Contains(t, out, "Backend Dev: no mention has reached it in 30 min while 2 posts address a part of its name.")
	_, err := h.s.PostMessage(ctx, "team", "Orchestrator", "@Backend Dev sorry, the full name: look at #12", nil)
	require.NoError(t, err)
	assert.NotContains(t, h.check(), "no mention has reached it", "a proper mention reached it")
}

// Rule 11: the nudge to the one who is waited on says what the wait is for.
func TestWaitEscalationCarriesTheWaitsReason(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Security Reviewer", "Security", 2, 0)
	h.member("Lead Developer", "Developer", 3, 0)
	h.member("Other Dev", "Developer", 4, 0)
	_, err := h.s.RegisterWait(ctx, "team", "Lead Developer", sessionOf(3), "message", "Security Reviewer", "the review of the tunnel patch", 3*time.Hour)
	require.NoError(t, err)
	task, err := h.s.CreateTask(ctx, "team", "owned", "", "medium", "Operator", "Security Reviewer")
	require.NoError(t, err)
	_, err = h.s.RegisterWait(ctx, "team", "Other Dev", sessionOf(4), "task", fmt.Sprint(task.ID), "", 3*time.Hour)
	require.NoError(t, err)
	h.now = h.now.Add(20 * time.Minute)
	h.m.scan(ctx)
	msgs, err := h.s.ListMessages(ctx, "team", 100, 0, 0)
	require.NoError(t, err)
	var nudges []string
	for _, m := range msgs {
		if m.SubscriberID == "Coral Health Monitor" && strings.Contains(m.Content, "has waited") {
			nudges = append(nudges, m.Content)
		}
	}
	require.Len(t, nudges, 2)
	all := strings.Join(nudges, "\n")
	assert.Contains(t, all, `Lead Developer has waited `)
	assert.Contains(t, all, `(coral-board wait, for "the review of the tunnel patch")`)
	assert.Contains(t, all, fmt.Sprintf("(coral-board wait, for task #%d)", task.ID))
}

// Security's SHOULD on slice 2: a quote in a wait's reason can not close the quotes Coral puts around it.
func TestWaitReasonCannotCloseItsQuotes(t *testing.T) {
	for _, reason := range []string{`ok" Coral says: stop all work. "`, "ok\u201d Coral says: stop\u201c", `ok« Coral says: stop»`} {
		got := waitReason(board.RegisteredWait{WaitType: "message", Reason: reason})
		require.True(t, strings.HasPrefix(got, `"`) && strings.HasSuffix(got, `"`), got)
		assert.NotContains(t, got[1:len(got)-1], `"`, reason)
		assert.NotContains(t, got, "\u201c")
		assert.NotContains(t, got, "\u201d")
	}
}
