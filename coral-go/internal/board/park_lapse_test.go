package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #11659 (the operator): a park whose end passes runs no code, so its owner got the slot back on top of the task claimed meanwhile: two tasks in progress, and a claim refused. The lapse is settled where the
// slot is judged (a claim, a list) and by the sweep: the task in hand stays in progress, the lapsed one goes back to pending with its owner, as UnparkTask does.
func holders(t *testing.T, s *Store, owner string) int {
	t.Helper()
	var n int
	require.NoError(t, s.db.Get(&n, `SELECT COUNT(*) FROM board_tasks WHERE board_id = 'team' AND assigned_to = ? AND `+holdsSlotSQL, owner))
	return n
}

func lapse(t *testing.T, s *Store, id int64) {
	t.Helper()
	_, err := s.db.Exec(`UPDATE board_tasks SET parked_until = ? WHERE id = ?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339), id)
	require.NoError(t, err)
}

func claimAndPark(t *testing.T, s *Store, title string, until time.Time) *Task {
	t.Helper()
	ctx := context.Background()
	task, err := s.CreateTask(ctx, "team", title, "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "worker", task.ID)
	require.NoError(t, err)
	_, err = s.ParkTask(ctx, "team", task.ID, "waiting on the operator", until)
	require.NoError(t, err)
	return task
}

func TestReleaseLapsedParks_TheLiveTaskKeepsTheSlot(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	a := claimAndPark(t, s, "Parked", time.Now().Add(time.Hour))
	live, err := s.CreateTask(ctx, "team", "Live", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "worker", live.ID)
	require.NoError(t, err, "a parked task holds no slot")
	require.Equal(t, 1, holders(t, s, "worker"))

	lapse(t, s, a.ID) // the park's end passes: nothing ran
	require.Equal(t, 2, holders(t, s, "worker"), "the lapse alone gives the owner two tasks in progress (the bug)")

	n, err := s.ReleaseLapsedParks(ctx, "team")
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, 1, holders(t, s, "worker"))
	got, err := s.GetTask(ctx, "team", a.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", got.Status, "the lapsed task is queued behind the one in hand")
	require.NotNil(t, got.AssignedTo)
	require.Equal(t, "worker", *got.AssignedTo, "its owner is kept")
	require.Nil(t, got.ParkedReason, "it is not parked any more")
	liveNow, err := s.GetTask(ctx, "team", live.ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", liveNow.Status)
}

func TestReleaseLapsedParks_SeveralLapsedKeepTheOldestClaim(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	a := claimAndPark(t, s, "First parked", time.Now().Add(time.Hour))
	b := claimAndPark(t, s, "Second parked", time.Now().Add(time.Hour))
	require.Equal(t, 0, holders(t, s, "worker"), "both parked: no slot held")
	lapse(t, s, a.ID)
	lapse(t, s, b.ID)
	require.Equal(t, 2, holders(t, s, "worker"))
	_, err := s.ReleaseLapsedParks(ctx, "")
	require.NoError(t, err)
	require.Equal(t, 1, holders(t, s, "worker"), "one in progress, the rest queued")
}

func TestReleaseLapsedParks_ClaimAndListSettleItToo(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	a := claimAndPark(t, s, "Parked", time.Now().Add(time.Hour))
	live, err := s.CreateTask(ctx, "team", "Live", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "worker", live.ID)
	require.NoError(t, err)
	lapse(t, s, a.ID)
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{})
	require.NoError(t, err)
	inProgress := 0
	for _, it := range page.Tasks {
		if it.Status == "in_progress" {
			inProgress++
		}
	}
	require.Equal(t, 1, inProgress, "the list never says two In progress for one owner")

}

func TestReleaseLapsedParks_AClaimSettlesItBeforeJudgingTheSlot(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	a := claimAndPark(t, s, "Parked", time.Now().Add(time.Hour))
	live, err := s.CreateTask(ctx, "team", "Live", "b", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", "worker", live.ID)
	require.NoError(t, err)
	lapse(t, s, a.ID)
	require.Equal(t, 2, holders(t, s, "worker"))
	_, err = s.ClaimTask(ctx, "team", "worker")
	require.ErrorIs(t, err, errSlotHeld, "refused for the one in hand")
	require.Equal(t, 1, holders(t, s, "worker"), "and the lapsed park was settled on the way")
	got, err := s.GetTask(ctx, "team", a.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", got.Status)
}

func TestReleaseLapsedParks_AParkStillAheadIsLeftAlone(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	a := claimAndPark(t, s, "Parked", time.Now().Add(time.Hour))
	n, err := s.ReleaseLapsedParks(ctx, "team")
	require.NoError(t, err)
	require.Equal(t, 0, n)
	got, err := s.GetTask(ctx, "team", a.ID)
	require.NoError(t, err)
	require.Equal(t, "in_progress", got.Status)
	require.NotNil(t, got.ParkedReason)
}
