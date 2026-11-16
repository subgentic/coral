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

// #17832: a task in review that has no open Review task after ten minutes is a line of the orchestrator's check, so nobody has to audit for the notices that got lost.
func TestTheCheckNamesATaskInReviewWithNoReviewTaskAfterTenMinutes(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("Rev", "Reviewer", 3, time.Minute)

	submit := func(title string) int64 {
		task, err := h.s.CreateTask(ctx, "team", title, "", "high", "Orchestrator", "Dev")
		require.NoError(t, err)
		_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
		require.NoError(t, err)
		_, err = h.s.SubmitCompletionReview(ctx, "team", task.ID, "Dev", "c", "success", "ready", []board.TaskArtifact{{Name: "o", Content: "x", Revision: "r1"}})
		require.NoError(t, err)
		_, _, err = h.s.HandToOrchestrator(ctx, "team", task.ID, "Dev")
		require.NoError(t, err)
		return task.ID
	}
	lost := submit("Secret title one")
	delegated := submit("Secret title two")
	_, _, err := h.s.DelegateReview(ctx, "team", delegated, "Orchestrator", []string{"Rev"})
	require.NoError(t, err)

	h.now = time.Now().UTC().Add(5 * time.Minute)
	h.m.scan(ctx)
	h.mu.Lock()
	for _, sent := range h.sent["Orchestrator"] {
		assert.NotContains(t, sent, "no Review task", "five minutes in: nothing yet")
	}
	h.mu.Unlock()

	h.now = time.Now().UTC().Add(25 * time.Minute)
	h.sent = map[string][]string{}
	text := h.checkTo("Orchestrator")
	assert.Contains(t, text, fmt.Sprintf("the review of #%d has waited", lost))
	assert.Contains(t, text, "no Review task is open")
	assert.Contains(t, text, fmt.Sprintf("task review %d --to", lost))
	assert.NotContains(t, text, fmt.Sprintf("the review of #%d has waited", delegated), "a review with its Review task open is not named")
	assert.NotContains(t, text, "Secret title", "numbers only, never a title")
}
