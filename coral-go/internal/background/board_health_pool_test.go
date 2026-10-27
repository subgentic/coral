package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #8957 (Goal #80): a review that has waited in the pool for 15 minutes is a line of the orchestrator's check, naming the areas no reviewer covers.

func TestPoolItemsSayWhichAreasNobodyCoversAfterFifteenMinutes(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	waits := []board.PoolWait{
		{TaskID: 5, Title: "A secret title", PooledAt: now.Add(-14*time.Minute - 59*time.Second), Areas: []string{"go"}, Needs: 1, Uncovered: []string{"go"}},
		{TaskID: 6, Title: "Covered but busy", PooledAt: now.Add(-15 * time.Minute), Areas: []string{"ui"}, Needs: 1},
		{TaskID: 7, PooledAt: now.Add(-40 * time.Minute), Areas: []string{"go", "security", "docs"}, Needs: 1, Uncovered: []string{"security", "docs"}},
		{TaskID: 8, PooledAt: now.Add(-20 * time.Minute), Needs: 1, Uncovered: []string{"any"}},
		{TaskID: 9, Title: "no pooled time", Needs: 1},
	}
	items := poolItems(waits, now)
	require.Len(t, items, 3, "#5 has waited just under 15 minutes, #9 has no time")
	byKey := map[string]string{}
	for _, it := range items {
		byKey[it.Key] = it.Problem
		assert.Equal(t, "Board", it.Agent)
		assert.NotContains(t, it.Problem+it.Suggest, "secret", "no title in the line")
	}
	assert.Equal(t, "the review of #6 has waited 15 min in the pool", byKey["pool|6"], "covered: it waits for a busy reviewer")
	assert.Equal(t, "the review of #7 has waited 40 min in the pool; no reviewer covers security, docs", byKey["pool|7"])
	assert.Equal(t, "the review of #8 has waited 20 min in the pool; the board has no reviewer that could take it", byKey["pool|8"])
	for _, it := range items {
		if it.Key == "pool|7" {
			assert.Contains(t, it.Suggest, "coral-board reviewer set")
			assert.Contains(t, it.Suggest, "task review 7")
		}
	}
	assert.Empty(t, poolItems(nil, now))
}

func TestTheCheckHasALineForAReviewThatWaitedInThePool(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("UIRev", "Reviewer", 3, time.Minute)
	yes := true
	ui := []string{"ui"}
	_, err := h.s.SetReviewSettings(ctx, "team", "UIRev", &yes, &ui)
	require.NoError(t, err)

	task, err := h.s.CreateTask(ctx, "team", "Change the Go code", "", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = h.s.SubmitCompletionReview(ctx, "team", task.ID, "Dev", "c", "success", "ready", []board.TaskArtifact{{Name: "o", Content: "x", Revision: "r1"}})
	require.NoError(t, err)
	_, _, err = h.s.HandToOrchestrator(ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	pooled, err := h.s.PutReviewInPool(ctx, "team", task.ID, []string{"go"}, 1)
	require.NoError(t, err)
	require.True(t, pooled)

	// ten minutes in: nothing to say; twenty: the line, with the area nobody covers
	h.now = time.Now().UTC().Add(10 * time.Minute)
	text := h.checkTo("Orchestrator")
	assert.NotContains(t, text, "in the pool")
	h.now = time.Now().UTC().Add(20 * time.Minute)
	h.sent = map[string][]string{}
	text = h.checkTo("Orchestrator")
	assert.Contains(t, text, "the review of #")
	assert.Contains(t, text, "min in the pool; no reviewer covers go")
	assert.NotContains(t, text, "Change the Go code", "the check holds numbers and areas, never a title")
	assert.Contains(t, text, "Needs you")
}
