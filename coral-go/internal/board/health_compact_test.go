package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCompactContextIsOffByDefaultWithA200kThresholdAndIsClamped(t *testing.T) {
	d := DefaultHealthSettings().CompactContext
	assert.False(t, d.On)
	assert.Equal(t, 200, d.ThresholdK)
	assert.False(t, d.Orchestrator)
	assert.Equal(t, "threshold", d.Trigger)
	h := DefaultHealthSettings()
	h.CompactContext.ThresholdK = 0
	assert.Equal(t, 200, h.Clamp().CompactContext.ThresholdK, "a body that does not carry it is the default")
	h.CompactContext.ThresholdK = 10
	assert.Equal(t, 50, h.Clamp().CompactContext.ThresholdK)
	h.CompactContext.ThresholdK = 5000
	assert.Equal(t, 900, h.Clamp().CompactContext.ThresholdK)
	h.CompactContext.Trigger = "sometimes"
	assert.Equal(t, "threshold", h.Clamp().CompactContext.Trigger, "a word that is none of them is the default")
	h.CompactContext.Trigger = "both"
	assert.Equal(t, "both", h.Clamp().CompactContext.Trigger)
}

func TestCompactContextIsStoredPerTeam(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "b.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	h := DefaultHealthSettings()
	h.CompactContext = HealthCompact{On: true, ThresholdK: 300, Orchestrator: true, Trigger: "task"}
	require.NoError(t, s.SetHealthSettings(ctx, "a", h))
	assert.Equal(t, HealthCompact{On: true, ThresholdK: 300, Orchestrator: true, Trigger: "task"}, s.GetHealthSettings(ctx, "a").CompactContext)
	assert.False(t, s.GetHealthSettings(ctx, "b").CompactContext.On, "another team keeps the default")
}

// The after-task trigger's question (#14849): when a member last finished a task, by completing it or by submitting it for review.
func TestFinishedTaskAtIsWhenAMemberCompletedOrSubmittedATask(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "b.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	_, ok := s.FinishedTaskAt(ctx, "team", "Dev")
	assert.False(t, ok, "nothing finished")

	task, err := s.CreateTask(ctx, "team", "Build it", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, ok = s.FinishedTaskAt(ctx, "team", "Dev")
	assert.False(t, ok, "a task in progress is not finished")

	_, err = s.CompleteTask(ctx, "team", task.ID, "Dev", nil)
	require.NoError(t, err)
	at, ok := s.FinishedTaskAt(ctx, "team", "Dev")
	assert.True(t, ok)
	assert.WithinDuration(t, time.Now(), at, 10*time.Second)
	_, ok = s.FinishedTaskAt(ctx, "team", "Someone Else")
	assert.False(t, ok, "another member's finish is not this one's")

	second, err := s.CreateTask(ctx, "team", "Review it", "", "medium", "Orchestrator", "Builder")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "Builder", second.ID)
	require.NoError(t, err)
	_, err = s.SubmitCompletionReview(ctx, "team", second.ID, "Builder", "done", "success", "the work is done", nil)
	require.NoError(t, err)
	_, ok = s.FinishedTaskAt(ctx, "team", "Builder")
	assert.True(t, ok, "submitting for review is finishing the work")
}
