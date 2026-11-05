package background

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #13707: an agent in the mac-heavy line behind another is in a queue, not waiting on a person. The check did not say so: it flagged 'Frontend Dev has waited 10 min on QA Reviewer 2' and told QA Reviewer 2
// that someone waited on them, when Frontend Dev was only behind them in the line.
func queueHarness(t *testing.T) (*checkHarness, *resourcequeue.Queue) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("QA Reviewer 2", "QA", 2, 0)
	h.member("Frontend Dev", "Developer", 3, 0)
	h.member("Backend Dev", "Developer", 4, 0)
	q, err := resourcequeue.New(resourcequeue.Config{})
	require.NoError(t, err)
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1}))
	_, err = q.Claim("mac-heavy", resourcequeue.Claimant{Agent: "QA Reviewer 2"}) // holds
	require.NoError(t, err)
	_, err = q.Claim("mac-heavy", resourcequeue.Claimant{Agent: "Frontend Dev"}) // in line, place 1
	require.NoError(t, err)
	h.m.SetResourceQueue(q)
	return h, q
}

func escalations(t *testing.T, h *checkHarness) []string {
	msgs, err := h.s.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if m.SubscriberID == "Coral Health Monitor" && strings.Contains(m.Content, "has waited") {
			out = append(out, m.Content)
		}
	}
	return out
}

func TestAWaitBehindTheHolderInAResourceLineIsNotAWaitOnThem(t *testing.T) {
	h, _ := queueHarness(t)
	h.wait(3, "Frontend Dev", "message", "QA Reviewer 2") // Frontend Dev waits for QA Reviewer 2's post: it is the one ahead in the mac-heavy line
	h.now = h.now.Add(30 * time.Minute)
	h.m.scan(context.Background())
	assert.Empty(t, escalations(t, h), "QA Reviewer 2 is not told anyone waits on them")
	out := h.check()
	assert.NotContains(t, out, "Frontend Dev has waited", "and the check does not list it as a wait")
}

func TestAWaitOnSomeoneNotInTheSameLineIsStillAWait(t *testing.T) {
	h, _ := queueHarness(t)
	h.wait(3, "Frontend Dev", "message", "Backend Dev") // Backend Dev is not in the line: a real wait on a person
	h.now = h.now.Add(30 * time.Minute)
	h.m.scan(context.Background())
	got := escalations(t, h)
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "@Backend Dev Frontend Dev has waited ")
	// and with no queue set (a Coral with the queue off) the original wait on QA Reviewer 2 is as it was
	h.m.SetResourceQueue(nil)
	h.wait(4, "Backend Dev", "message", "QA Reviewer 2")
	h.now = h.now.Add(30 * time.Minute)
	h.m.scan(context.Background())
	assert.Len(t, escalations(t, h), 2)
}

func TestAWaitOnTheAgentBehindYouInTheLineIsStillAWait(t *testing.T) {
	h, q := queueHarness(t)
	_, err := q.Claim("mac-heavy", resourcequeue.Claimant{Agent: "Backend Dev"}) // place 2
	require.NoError(t, err)
	h.wait(3, "Frontend Dev", "message", "Backend Dev") // Backend Dev is BEHIND Frontend Dev: the line does not answer this wait
	h.now = h.now.Add(30 * time.Minute)
	h.m.scan(context.Background())
	assert.Len(t, escalations(t, h), 1)
}
