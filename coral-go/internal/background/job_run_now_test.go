package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #9293: Run now makes the job's own run, once, and leaves the schedule where it was.
func TestRunNowRecordsTheJobsRunAndKeepsTheSchedule(t *testing.T) {
	ctx := context.Background()
	s, ss, job := jobWithRuns(t) // a daily 09:00 job, no runs
	var launched []int64
	s.SetLaunchFn(func(_ context.Context, _ store.ScheduledJob, runID int64) error {
		launched = append(launched, runID)
		return nil
	})

	id, err := s.RunNow(ctx, job.ID)
	require.NoError(t, err)
	run, err := ss.GetActiveRunForJob(ctx, job.ID)
	require.NoError(t, err)
	require.NotNil(t, run, "the run is the job's, pending or running")
	assert.Equal(t, id, run.ID)
	require.NotNil(t, run.TriggerType)
	assert.Equal(t, "manual", *run.TriggerType)

	_, err = s.RunNow(ctx, job.ID)
	assert.ErrorIs(t, err, ErrJobRunning, "a job that is running is not run twice")
	_, err = s.RunNow(ctx, job.ID+999)
	assert.ErrorIs(t, err, ErrJobNotFound)

	// the manual run is not the schedule's last slot, so it does not move the next one
	last, err := ss.GetLastCronRunForJob(ctx, job.ID)
	require.NoError(t, err)
	assert.Nil(t, last)
	lastAny, err := ss.GetLastRunForJob(ctx, job.ID)
	require.NoError(t, err)
	assert.Equal(t, id, lastAny.ID)
}

func TestRunNowWorksForAPausedJobAndSchedulerFull(t *testing.T) {
	ctx := context.Background()
	s, ss, job := jobWithRuns(t)
	s.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error { return nil })
	_, err := ss.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"enabled": 0})
	require.NoError(t, err)
	_, err = s.RunNow(ctx, job.ID)
	require.NoError(t, err, "a person asked for it: a paused job runs")

	s2, _, job2 := jobWithRuns(t)
	s2.maxConcurrent = 1
	s2.running[999] = func() {}
	_, err = s2.RunNow(ctx, job2.ID)
	var full *ConcurrencyLimitError
	assert.ErrorAs(t, err, &full)
}

// A manual run an hour ago does not stop the schedule's own slot: the cron run is counted from the last run the schedule made.
func TestManualRunDoesNotSkipTheScheduledSlot(t *testing.T) {
	ctx := context.Background()
	s, ss, job := jobWithRuns(t)
	s.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error { return nil })
	slot := time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)
	// the job was changed before the slot, and a manual run finished at 09:00:30, after the slot came due
	_, err := ss.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"cron_expr": "0 9 * * *"})
	require.NoError(t, err)
	j, err := ss.GetScheduledJob(ctx, job.ID)
	require.NoError(t, err)
	j.UpdatedAt = slot.Add(-2 * time.Hour).Format(store.ISOFormat)
	id, err := ss.CreateScheduledRunTrigger(ctx, job.ID, slot.Add(30*time.Second).Format(store.ISOFormat), "completed", store.TriggerManual)
	require.NoError(t, err)
	require.NoError(t, ss.UpdateScheduledRun(ctx, id, map[string]interface{}{"status": "completed"}))
	require.NoError(t, s.evaluateJob(ctx, *j, slot.Add(time.Minute)))
	runs, err := ss.GetRunsForJob(ctx, job.ID, 10)
	require.NoError(t, err)
	require.Len(t, runs, 2, "the 09:00 slot ran although a manual run came after it")
}
