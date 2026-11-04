package background

import (
	"context"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestChiefScheduleDispatchesToDeliveryWithoutLaunchingAnAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "checks.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewScheduleStore(db)
	ctx := context.Background()
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "check", JobType: "check", CronExpr: "*/5 * * * *", Timezone: "UTC", Enabled: 0})
	require.NoError(t, err)
	s := NewJobScheduler(ss, time.Minute)
	var launched, calls atomic.Int64
	s.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error { launched.Add(1); return nil })
	gate := make(chan struct{})
	s.SetCheckDeliveryFn(func(context.Context, store.ScheduledJob, int64) error { calls.Add(1); <-gate; return nil })
	id, err := s.RunNow(ctx, job.ID)
	require.NoError(t, err, "Run now works while the check is disabled")
	_, err = s.RunNow(ctx, job.ID)
	require.ErrorIs(t, err, ErrJobRunning)
	close(gate)
	require.Eventually(t, func() bool { r, _ := ss.GetScheduledRun(ctx, id); return r != nil && r.Status == "completed" }, time.Second, 5*time.Millisecond)
	s.watching.Wait()
	require.EqualValues(t, 0, launched.Load())
	require.EqualValues(t, 1, calls.Load())
}
func TestChiefScheduleRestartUsesDurableDeliveryAndFailsClosedWithoutAdapter(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "checks.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewScheduleStore(db)
	ctx := context.Background()
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "check", JobType: "check", CronExpr: "0 * * * *", Timezone: "UTC"})
	require.NoError(t, err)
	id, err := ss.CreateScheduledRun(ctx, job.ID, time.Now().UTC().Format(store.ISOFormat), "pending")
	require.NoError(t, err)
	s := NewJobScheduler(ss, time.Minute)
	var deliveries atomic.Int64
	s.SetCheckDeliveryFn(func(context.Context, store.ScheduledJob, int64) error { deliveries.Add(1); return nil })
	s.reapStaleRuns(ctx)
	require.Eventually(t, func() bool { r, _ := ss.GetScheduledRun(ctx, id); return r != nil && r.Status == "completed" }, time.Second, 5*time.Millisecond)
	s.watching.Wait()
	require.EqualValues(t, 1, deliveries.Load())
	cold := NewJobScheduler(ss, time.Minute)
	id, err = cold.RunNow(ctx, job.ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool { r, _ := ss.GetScheduledRun(ctx, id); return r != nil && r.Status == "failed" }, time.Second, 5*time.Millisecond)
	cold.watching.Wait()
}

func TestChiefScheduleAdapterPanicPersistsFailure(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "checks.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewScheduleStore(db)
	ctx := context.Background()
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "check", JobType: "check", CronExpr: "0 * * * *", Timezone: "UTC"})
	require.NoError(t, err)
	s := NewJobScheduler(ss, time.Minute)
	s.SetCheckDeliveryFn(func(context.Context, store.ScheduledJob, int64) error { panic("adapter failed") })
	id, err := s.RunNow(ctx, job.ID)
	require.NoError(t, err)
	s.watching.Wait()
	run, err := ss.GetScheduledRun(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "failed", run.Status)
}
