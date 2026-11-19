package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19910: a reviewer parked in `coral-board wait` is inside a tool call with no end, so a line typed to its terminal is not read until
// the wait ends. QA Reviewer 2 rejected a round, parked on its review task, and sat there for 80 minutes while two resubmissions named it:
// Coral's own notices never ended a wait, only an agent's post did. A notice that names a parked agent now ends its wait and says so.
func TestAResubmittedReviewEndsTheWaitOfAParkedReviewer(t *testing.T) {
	base, h, first := reviewTeam(t, "park", true)
	ctx := context.Background()
	terminal := newMockTerminal()
	const qa = "claude-0000002b-3864-4864-8864-00000000002b"
	terminal.addSession(qa, "/tmp/qa")
	_, err := h.bs.Subscribe(ctx, "park", "QA Engineer", "QA Engineer", qa, nil, "mentions")
	require.NoError(t, err)
	h.SetTerminal(terminal)

	submit(t, base, first.ID)
	code, out := postCode(t, base(first.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"QA Engineer"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, err := h.bs.GetTask(ctx, "park", first.ID)
	require.NoError(t, err)
	review := got.Workflow.ReviewRounds[0].Reviewers[0].ReviewTaskID
	_, err = h.bs.ClaimTask(ctx, "park", "QA Engineer", review)
	require.NoError(t, err)
	code, out = postCode(t, base(first.ID, "reject"), map[string]any{"subscriber_id": "QA Engineer", "note": "no", "round": 1})
	require.Equal(t, http.StatusOK, code, "%v", out)

	// the reviewer parks on its review task, as it did, then the author fixes and resubmits
	_, err = h.bs.RegisterWait(ctx, "park", "QA Engineer", qa, "task", "99999", "", time.Hour)
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "park", "worker", first.ID)
	require.NoError(t, err)
	submit(t, base, first.ID)

	require.Eventually(t, func() bool {
		w, _ := h.bs.GetActiveWait(ctx, "park", "QA Engineer")
		return w == nil
	}, 2*time.Second, 20*time.Millisecond, "the notice that names the parked reviewer ends its wait")
	require.Eventually(t, func() bool {
		for _, s := range terminal.sentTo(qa) {
			if strings.Contains(s, "[Wait resolved]") {
				return true
			}
		}
		return false
	}, 2*time.Second, 20*time.Millisecond, "and its terminal is told, so the tool call returns and it reads the board")
	assert.NotNil(t, got)
}
