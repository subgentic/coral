package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openPruneDB(t *testing.T) *DB {
	t.Helper()
	db, err := OpenWithKey(context.Background(), filepath.Join(t.TempDir(), "p.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	return db
}

// Quiet runs are kept apart: a check that runs every few minutes and finds nothing never pushes the runs that did something out of the history.
func TestQuietWorkflowRunsNeverPushRealRunsOutOfHistory(t *testing.T) {
	ctx := context.Background()
	ws := NewWorkflowStore(openPruneDB(t))
	wf, err := ws.CreateWorkflow(ctx, &Workflow{Name: "prod-alerts", StepsJSON: `[]`, DefaultAgentJSON: "{}", Enabled: 1})
	require.NoError(t, err)
	var real []int64
	for i := 0; i < 3; i++ { // three runs that did something
		r, err := ws.CreateWorkflowRun(ctx, wf.ID, "scheduled", nil)
		require.NoError(t, err)
		require.NoError(t, ws.SetRunStatus(ctx, r.ID, "completed", nil))
		real = append(real, r.ID)
	}
	for i := 0; i < 300; i++ { // a day of quiet five-minute runs
		r, err := ws.CreateWorkflowRun(ctx, wf.ID, "scheduled", nil)
		require.NoError(t, err)
		require.NoError(t, ws.SetRunQuiet(ctx, r.ID))
		if i%50 == 49 {
			_, err := ws.PruneWorkflowRuns(ctx, wf.ID, 50)
			require.NoError(t, err)
		}
	}
	running, err := ws.CreateWorkflowRun(ctx, wf.ID, "scheduled", nil)
	require.NoError(t, err)
	_, err = ws.PruneWorkflowRuns(ctx, wf.ID, 50)
	require.NoError(t, err)

	ids, err := ws.WorkflowRunIDs(ctx, wf.ID)
	require.NoError(t, err)
	have := map[int64]bool{}
	for _, id := range ids {
		have[id] = true
	}
	for _, id := range real {
		assert.True(t, have[id], "run %d did something and stays", id)
	}
	assert.True(t, have[running.ID], "a run still going is never pruned")
	quiet := 0
	for _, id := range ids {
		r, _ := ws.GetWorkflowRunDirect(ctx, id)
		if r.Status == RunQuiet {
			quiet++
		}
	}
	assert.Equal(t, QuietRunsKept, quiet, "only the newest quiet runs stay")

	// real runs beyond 50 are pruned as before, and quiet runs do not count toward the 50
	for i := 0; i < 60; i++ {
		r, _ := ws.CreateWorkflowRun(ctx, wf.ID, "scheduled", nil)
		require.NoError(t, ws.SetRunStatus(ctx, r.ID, "failed", nil))
	}
	_, err = ws.PruneWorkflowRuns(ctx, wf.ID, 50)
	require.NoError(t, err)
	ids, _ = ws.WorkflowRunIDs(ctx, wf.ID)
	other := 0
	for _, id := range ids {
		if r, _ := ws.GetWorkflowRunDirect(ctx, id); r.Status != RunQuiet {
			other++
		}
	}
	assert.Equal(t, 51, other, "the newest 50 runs that did something, and the older one still going, which is never pruned")
}

func TestScheduledRunsAreKeptFiftyPerJobAndQuietOnesApart(t *testing.T) {
	ctx := context.Background()
	db := openPruneDB(t)
	ss := NewScheduleStore(db)
	job := func(name string) int64 {
		res, err := db.ExecContext(ctx, `INSERT INTO scheduled_jobs (name, cron_expr, repo_path, prompt, created_at, updated_at) VALUES (?, '*/5 * * * *', '/tmp', 'p', 'now', 'now')`, name)
		require.NoError(t, err)
		id, _ := res.LastInsertId()
		return id
	}
	a, b := job("alerts"), job("other")
	mk := func(id int64, status string) int64 {
		run, err := ss.CreateScheduledRun(ctx, id, "2026-11-25T00:00:00Z", "pending")
		require.NoError(t, err)
		require.NoError(t, ss.UpdateScheduledRun(ctx, run, map[string]interface{}{"status": status}))
		return run
	}
	var kept []int64
	for i := 0; i < 2; i++ {
		kept = append(kept, mk(a, "failed"))
	}
	for i := 0; i < 120; i++ {
		mk(a, "quiet")
	}
	for i := 0; i < 70; i++ {
		kept = append(kept, mk(a, "completed"))
	}
	pending := mk(a, "pending")
	bRun := mk(b, "completed")
	n, err := ss.PruneScheduledRuns(ctx, a, ScheduledRunsKept)
	require.NoError(t, err)
	assert.Greater(t, n, int64(0))

	count := func(job int64, status string) int {
		var c int
		require.NoError(t, db.GetContext(ctx, &c, `SELECT COUNT(*) FROM scheduled_runs WHERE job_id = ? AND status = ?`, job, status))
		return c
	}
	assert.Equal(t, QuietRunsKept, count(a, "quiet"))
	assert.Equal(t, 49, count(a, "completed")+count(a, "failed"), "the newest 50 of its other runs stay, and the one still going is among them")
	assert.Equal(t, 0, count(a, "failed"), "the oldest are the ones removed")
	assert.Equal(t, 1, count(a, "pending"), "a run still going stays")
	var c int
	require.NoError(t, db.GetContext(ctx, &c, `SELECT COUNT(*) FROM scheduled_runs WHERE id = ?`, pending))
	assert.Equal(t, 1, c)
	require.NoError(t, db.GetContext(ctx, &c, `SELECT COUNT(*) FROM scheduled_runs WHERE id = ?`, bRun))
	assert.Equal(t, 1, c, "another job's runs are not touched")
	_ = kept
}
