package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17977: the check said "Frontend Dev 3 has waited 10 min on Frontend Dev 3 ... for task #16615". A wait whose waiter and awaited are the same agent is never a wait on someone: the agent's own post
// (a START line) answers nothing, and nobody is told to reply to themselves.
func TestAWaitOnTheWaiterItselfIsNeverListed(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Frontend Dev 3", "Developer", 3, 0)
	h.member("Backend Dev", "Developer", 4, 0)
	h.wait(3, "Frontend Dev 3", "message", "Frontend Dev 3")
	h.wait(4, "Backend Dev", "message", "Frontend Dev 3") // a real wait on someone else, still listed
	h.now = h.now.Add(30 * time.Minute)
	h.m.scan(context.Background())
	out := h.check()
	assert.NotContains(t, out, "Frontend Dev 3 has waited", "an agent is not reported as waiting on itself")
	assert.Contains(t, out, "Backend Dev has waited", "a wait on another agent is as it was")
	for _, e := range escalations(t, h) {
		assert.NotContains(t, e, "@Frontend Dev 3 Frontend Dev 3", "nobody is told to reply to themselves")
	}
}

func TestAWaitOnTheWaiterItselfIsNotADeviation(t *testing.T) {
	d := newDeviationHarness(t)
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Frontend Dev 3", "Developer", 3, 0)
	d.answered("Frontend Dev 3", "message", "Frontend Dev 3", 5*time.Minute)
	d.wait(3, "Frontend Dev 3", "message", "Frontend Dev 3")
	_, err := d.raw.ExecContext(context.Background(), `UPDATE board_waits SET created_at=? WHERE status='active'`, ts(d.now.Add(-21*time.Minute)))
	require.NoError(t, err)
	assert.NotContains(t, d.check(), "Frontend Dev 3: has waited")
}
