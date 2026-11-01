package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func TestParkSweep_QueuesALapsedParkBehindTheTaskInHand(t *testing.T) {
	ctx := context.Background()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	a, err := bs.CreateTask(ctx, "team", "Parked", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "worker", a.ID)
	require.NoError(t, err)
	_, err = bs.ParkTask(ctx, "team", a.ID, "waiting on the operator", time.Now().Add(time.Second))
	require.NoError(t, err)
	live, err := bs.CreateTask(ctx, "team", "Live", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "worker", live.ID) // a parked task holds no slot
	require.NoError(t, err)
	time.Sleep(2100 * time.Millisecond) // the park's end passes: nothing runs, and the owner has two tasks in progress
	require.Equal(t, 1, NewParkSweep(bs).RunOnce(ctx), "the sweep queues the lapsed task behind the one in hand")
	got, err := bs.GetTask(ctx, "team", a.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", got.Status)
	require.Nil(t, got.ParkedReason)
	liveNow, err := bs.GetTask(ctx, "team", live.ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", liveNow.Status)
}
