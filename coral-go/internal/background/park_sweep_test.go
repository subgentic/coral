package background

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func TestParkSweep_QueuesALapsedParkBehindTheTaskInHand(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "board.db")
	bs, err := board.NewStoreWithKey(dbPath, "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	a, err := bs.CreateTask(ctx, "team", "Parked", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "worker", a.ID)
	require.NoError(t, err)
	_, err = bs.ParkTask(ctx, "team", a.ID, "waiting on the operator", time.Now().Add(time.Hour)) // an end far away: no step below can outlast it, however slow the machine (#15337, -race)
	require.NoError(t, err)
	live, err := bs.CreateTask(ctx, "team", "Live", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "worker", live.ID) // a parked task holds no slot
	require.NoError(t, err)
	// the park's end passes: the end is moved into the past, not waited for (a 1 s park lapsed under -race before the second claim, which then saw the parked task as in hand). Nothing runs, and the owner has two tasks in progress.
	raw, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	res, err := raw.ExecContext(ctx, `UPDATE board_tasks SET parked_until = ? WHERE id = ?`, time.Now().UTC().Add(-time.Minute).Format("2006-01-02T15:04:05Z"), a.ID)
	require.NoError(t, err)
	n, err := res.RowsAffected()
	require.NoError(t, err)
	require.EqualValues(t, 1, n, "the park's end was moved")
	require.Equal(t, 1, NewParkSweep(bs).RunOnce(ctx), "the sweep queues the lapsed task behind the one in hand")
	got, err := bs.GetTask(ctx, "team", a.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", got.Status)
	require.Nil(t, got.ParkedReason)
	liveNow, err := bs.GetTask(ctx, "team", live.ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", liveNow.Status)
}
