package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const reviewerSID = "22222222-2222-2222-2222-222222222222"

// #19910: a review task in an idle reviewer's queue is nudged within minutes, and escalated to the orchestrator when it is still unclaimed 10 minutes after that.
// QA Reviewer 2 sat parked in `coral-board wait` with two resubmissions named to it for 80 minutes: the claim nudge stood down for any agent with a wait.
func TestAReviewWaitingForAParkedReviewerIsNudgedAndEscalated(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	n.agent("QA", reviewerSID)
	// it parked on something older than the review (as it did: its own review task), so it looks mid-turn
	_, err := n.bs.RegisterWait(ctx, "team", "QA", "claude-"+reviewerSID, "task", "999", "", 6*time.Hour)
	require.NoError(t, err)
	time.Sleep(1100 * time.Millisecond)
	_, err = n.bs.CreateTask(ctx, "team", "Review #5: the thing", "", "high", "Operator", "QA")
	require.NoError(t, err)
	n.sig[reviewerSID] = agentSignal{InTurn: true, Since: n.now.Add(-80 * time.Minute)}

	n.run(time.Minute)
	assert.Empty(t, n.sentTo("QA"), "a review that has waited a minute is not yet late")
	n.run(2 * time.Minute)
	require.Len(t, n.sentTo("QA"), 1, "within minutes of the review reaching its queue")
	assert.Contains(t, n.sentTo("QA")[0], "coral-board task claim")
	w, _ := n.bs.GetActiveWait(ctx, "team", "QA")
	assert.Nil(t, w, "the old wait is ended so the tool call returns and the nudge is read")
	n.run(5 * time.Minute)
	assert.Len(t, n.sentTo("QA"), 1, "one nudge, not a drip")
	n.run(6 * time.Minute)
	assert.Contains(t, joined(n.lines()), "escalated to the orchestrator: QA has not claimed review #", "10 minutes after the nudge it goes to the orchestrator")
	before := len(n.lines())
	n.run(30 * time.Minute)
	assert.Len(t, n.lines(), before, "escalated once")
	assert.Len(t, n.sentTo("QA"), 1)
}

func joined(ls []string) string {
	s := ""
	for _, l := range ls {
		s += l + "\n"
	}
	return s
}

// An idle reviewer that is not parked is nudged once for its review (not twice: the claim nudge does not repeat it), and one working on its own task is left alone.
func TestAReviewNudgeIsOneAndSkipsAWorkingReviewer(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	n.agent("QA", reviewerSID)
	_, err := n.bs.CreateTask(ctx, "team", "Review #6: the thing", "", "high", "Operator", "QA")
	require.NoError(t, err)
	n.sig[reviewerSID] = agentSignal{Since: n.now.Add(-time.Hour)}
	n.run(3 * time.Minute)
	n.run(8 * time.Minute) // past the claim nudge's own idle period too
	assert.Len(t, n.sentTo("QA"), 1, "one nudge for one review: %v", n.sentTo("QA"))

	m := newNudgeHarness(t, "")
	m.agent("QA", reviewerSID)
	_, err = m.bs.CreateTask(ctx, "team", "Review #7: the thing", "", "high", "Operator", "QA")
	require.NoError(t, err)
	own, err := m.bs.CreateTask(ctx, "team", "Own work", "", "high", "Operator", "QA")
	require.NoError(t, err)
	_, err = m.bs.ClaimTask(ctx, "team", "QA", own.ID)
	require.NoError(t, err)
	m.sig[reviewerSID] = agentSignal{Since: m.now.Add(-time.Hour)}
	m.run(12 * time.Minute) // under the status nudge's 30 minutes
	assert.Empty(t, m.sentTo("QA"), "a reviewer at work on its own task is not interrupted (the review is offered when that ends)")
}

// A wait that began after the review was in the queue is the reviewer's own choice: it is neither ended nor nudged over.
func TestAReviewNudgeLeavesAWaitTheReviewerMadeAfterwards(t *testing.T) {
	n := newNudgeHarness(t, "")
	ctx := context.Background()
	n.agent("QA", reviewerSID)
	_, err := n.bs.CreateTask(ctx, "team", "Review #8: the thing", "", "high", "Operator", "QA")
	require.NoError(t, err)
	time.Sleep(1100 * time.Millisecond)
	_, err = n.bs.RegisterWait(ctx, "team", "QA", "claude-"+reviewerSID, "message", "Orchestrator", "", 6*time.Hour)
	require.NoError(t, err)
	n.sig[reviewerSID] = agentSignal{InTurn: true, Since: n.now.Add(-time.Hour)}
	n.run(5 * time.Minute)
	assert.Empty(t, n.sentTo("QA"))
	w, _ := n.bs.GetActiveWait(ctx, "team", "QA")
	assert.NotNil(t, w)
}
