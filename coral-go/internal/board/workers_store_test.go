package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkerStoreCrud(t *testing.T) {
	ctx := context.Background()
	bs := testStore(t)
	w, err := bs.SaveWorker(ctx, "team", "", Worker{Name: "Reviewer", AgentType: "claude", Instructions: "Read only."}, false)
	require.NoError(t, err)
	require.Equal(t, "Reviewer", w.Name)
	_, err = bs.SaveWorker(ctx, "team", "", Worker{Name: "reviewer", AgentType: "codex"}, false)
	require.ErrorIs(t, err, ErrWorkerExists, "names are unique in any case")
	_, err = bs.SaveWorker(ctx, "other", "", Worker{Name: "Reviewer", AgentType: "codex"}, false)
	require.NoError(t, err, "another team has its own list")
	got, err := bs.SaveWorker(ctx, "team", "REVIEWER", Worker{Name: "Checker", AgentType: "claude"}, true)
	require.NoError(t, err)
	require.Equal(t, w.CreatedAt, got.CreatedAt, "an edit keeps the worker's age")
	_, err = bs.GetWorker(ctx, "team", "Reviewer")
	require.ErrorIs(t, err, ErrWorkerNotFound)
	list, err := bs.ListWorkers(ctx, "team")
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.NoError(t, bs.RecordWorkerLaunch(ctx, "team", "claude-1", "Checker", 7))
	m, _ := bs.WorkerLaunches(ctx, "team")
	require.Equal(t, "Checker", m["claude-1"])
	require.NoError(t, bs.DeleteWorker(ctx, "team", "checker"))
	require.ErrorIs(t, bs.DeleteWorker(ctx, "team", "checker"), ErrWorkerNotFound)
	for i := 0; i < MaxWorkersPerTeam; i++ {
		_, err = bs.SaveWorker(ctx, "full", "", Worker{Name: string(rune('A' + i)), AgentType: "claude"}, false)
		require.NoError(t, err)
	}
	_, err = bs.SaveWorker(ctx, "full", "", Worker{Name: "Z", AgentType: "claude"}, false)
	require.ErrorIs(t, err, ErrWorkerLimit)
}
