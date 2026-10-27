package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9315: a run is opened once, for every screen: seen_at is set the first time and kept; a run still going or never opened has none; the runs that are over when the column is added are
// given the time (nobody is told about a history they never saw), and a run finished after that is unread until it is opened.
func TestRunSeenAt(t *testing.T) {
	db := openTestDB(t)
	sched, wfs := NewScheduleStore(db), NewWorkflowStore(db)
	ctx := context.Background()
	job, err := sched.CreateScheduledJob(ctx, &ScheduledJob{Name: "j", CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	over, err := sched.CreateScheduledRun(ctx, job.ID, "2026-10-01T00:00:00Z", "failed")
	require.NoError(t, err)
	going, err := sched.CreateScheduledRun(ctx, job.ID, "2026-10-01T00:01:00Z", "running")
	require.NoError(t, err)
	wf, err := wfs.CreateWorkflow(ctx, &Workflow{Name: "w", Enabled: 1})
	require.NoError(t, err)
	wrun, err := wfs.CreateWorkflowRun(ctx, wf.ID, "ui", nil)
	require.NoError(t, err)
	require.NoError(t, wfs.UpdateWorkflowRun(ctx, wrun.ID, map[string]interface{}{"status": "failed"}))

	// nothing is opened yet
	r, err := sched.GetScheduledRun(ctx, over)
	require.NoError(t, err)
	assert.Nil(t, r.SeenAt)
	// the first open sets the time, a second keeps the first
	found, err := sched.MarkScheduledRunSeen(ctx, over, "2026-10-27T10:00:00Z")
	require.NoError(t, err)
	assert.True(t, found)
	found, err = sched.MarkScheduledRunSeen(ctx, over, "2026-10-27T11:00:00Z")
	require.NoError(t, err)
	assert.True(t, found)
	r, err = sched.GetScheduledRun(ctx, over)
	require.NoError(t, err)
	require.NotNil(t, r.SeenAt)
	assert.Equal(t, "2026-10-27T10:00:00Z", *r.SeenAt, "the first open's time is kept")
	found, err = sched.MarkScheduledRunSeen(ctx, 99999, "2026-10-27T10:00:00Z")
	require.NoError(t, err)
	assert.False(t, found, "no such run")
	found, err = wfs.MarkWorkflowRunSeen(ctx, wrun.ID, "2026-10-27T10:00:00Z")
	require.NoError(t, err)
	assert.True(t, found)
	found, err = wfs.MarkWorkflowRunSeen(ctx, 99999, "2026-10-27T10:00:00Z")
	require.NoError(t, err)
	assert.False(t, found)
	w, err := wfs.GetWorkflowRun(ctx, wrun.ID)
	require.NoError(t, err)
	require.NotNil(t, w.SeenAt)

	// a database from before the column: ensureSchema adds it and gives every finished run the time, none to the one still going
	for _, table := range []string{"scheduled_runs", "workflow_runs"} {
		_, err := db.ExecContext(ctx, "ALTER TABLE "+table+" DROP COLUMN seen_at")
		require.NoError(t, err)
	}
	require.NoError(t, db.ensureSchema(ctx))
	r, err = sched.GetScheduledRun(ctx, over)
	require.NoError(t, err)
	assert.NotNil(t, r.SeenAt, "a run over when the column was added is not news")
	r, err = sched.GetScheduledRun(ctx, going)
	require.NoError(t, err)
	assert.Nil(t, r.SeenAt, "a run still going has no time")
	w, err = wfs.GetWorkflowRun(ctx, wrun.ID)
	require.NoError(t, err)
	assert.NotNil(t, w.SeenAt)

	// and the backfill runs once: a run that fails after it is unread, whatever the next open does
	late, err := sched.CreateScheduledRun(ctx, job.ID, "2026-10-27T12:00:00Z", "failed")
	require.NoError(t, err)
	require.NoError(t, db.ensureSchema(ctx))
	r, err = sched.GetScheduledRun(ctx, late)
	require.NoError(t, err)
	assert.Nil(t, r.SeenAt, "the next open does not mark a new failure as opened")
}
