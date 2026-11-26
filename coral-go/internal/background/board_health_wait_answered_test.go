package background

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21702 (coral-hub's audit): a wait on the recipient is cleared by any post of the recipient that answers the waiter, not only by one that mentions them: a reply (post --reply-to) to the waiter's
// message, or a post on the task the waiter waits for. Before, "waits on YOU" stayed after an answer posted without a mention.
func TestAWaitOnYouEndsWhenYouAnswerWithAReplyOrOnItsTask(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("QA", "QA Engineer", 3, 0)
	asked, err := h.s.PostMessage(ctx, "team", "Dev", "ready for review?", nil)
	require.NoError(t, err)
	h.wait(2, "Dev", "message", "Orchestrator")
	task, err := h.s.CreateTask(ctx, "team", "held", "", "medium", "Operator", "Orchestrator")
	require.NoError(t, err)
	h.wait(3, "QA", "task", fmt.Sprint(task.ID))
	out := h.check()
	assert.Contains(t, out, "Dev has waited ", "still waiting before any answer")

	// An answer with no mention of the waiter: a reply to its message.
	ans, err := h.s.PostMessage(ctx, "team", "Orchestrator", "go ahead", nil)
	require.NoError(t, err)
	require.NoError(t, h.s.RecordReply(ctx, "team", ans.ID, asked.ID))
	out = h.check()
	assert.NotContains(t, out, "Dev has waited ", "answered by a reply: not a line")

	// A post on the task the waiter waits for, by the one it waits on.
	tid := task.ID
	_, err = h.s.PostMessageForTask(ctx, "team", "Orchestrator", "taking it now", nil, "", &tid)
	require.NoError(t, err)
	assert.NotContains(t, h.check(), "QA has waited ", "answered on its task: not a line")
}

// A post that answers nobody (another thread, no mention) leaves the wait standing.
func TestAWaitOnYouStandsAfterAnUnrelatedPost(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	_, err := h.s.PostMessage(ctx, "team", "Dev", "ready for review?", nil)
	require.NoError(t, err)
	h.wait(2, "Dev", "message", "Orchestrator")
	_, err = h.s.PostMessage(ctx, "team", "Orchestrator", "the release is going out at noon", nil)
	require.NoError(t, err)
	assert.Contains(t, h.check(), "Dev has waited ")
}
