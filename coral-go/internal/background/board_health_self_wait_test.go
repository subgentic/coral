package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A member who waits on a task assigned to themselves waits on nobody: the check named it "Frontend Dev 3 has waited 21 min on Frontend Dev 3" and buried the real lines (#18064).
func TestTheCheckDoesNotReportAMemberAsWaitingOnThemselves(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Frontend Dev 3", "Frontend Dev", 2, 0)
	h.member("Dev B", "Developer", 3, 0)
	own, err := h.s.CreateTask(ctx, "team", "mine", "", "medium", "Operator", "Frontend Dev 3")
	require.NoError(t, err)
	h.wait(2, "Frontend Dev 3", "task", fmt.Sprint(own.ID))  // on a task it holds itself
	h.wait(2, "Frontend Dev 3", "message", "Frontend Dev 3") // and on its own name
	h.wait(3, "Dev B", "message", "Frontend Dev 3")          // a real wait, on someone else
	h.now = time.Now().UTC().Add(20 * time.Minute)
	out := h.check()
	assert.NotContains(t, out, "Frontend Dev 3 has waited", "no line for a member's wait on themselves")
	assert.Contains(t, out, "Dev B has waited ", "a real wait is still said")
}
