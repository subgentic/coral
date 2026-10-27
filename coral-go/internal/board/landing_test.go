package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8942, #9001: the tasks waiting to land are those completed after the time with a success outcome; a failed task and an earlier one are not.
func TestFinishedSinceCountsSuccessfulWorkAfterTheTime(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	_, err = s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	done := func(title, outcome string) *Task {
		task, err := s.CreateTask(ctx, "team", title, "", "high", "Dev", "Dev")
		require.NoError(t, err)
		_, err = s.ClaimTask(ctx, "team", "Dev", task.ID)
		require.NoError(t, err)
		_, err = s.CompleteTaskWithArtifacts(ctx, "team", task.ID, "Dev", nil, outcome, nil)
		require.NoError(t, err)
		return task
	}
	before := time.Now().UTC().Add(-time.Minute)
	done("fine", "success")
	done("implied", "")
	done("broken", "failed")
	n, err := s.FinishedSince(ctx, "team", before)
	require.NoError(t, err)
	assert.Equal(t, 2, n, "the stated success and the implied one; the failed one is out")
	n, err = s.FinishedSince(ctx, "team", time.Now().UTC().Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, 0, n, "nothing completed after a later time")
}
