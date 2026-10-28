package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestScheduledJobsCRUD(t *testing.T) {
	db := openTestDB(t)
	s := NewScheduleStore(db)
	ctx := context.Background()

	job, err := s.CreateScheduledJob(ctx, &ScheduledJob{
		Name:     "nightly-tests",
		CronExpr: "0 0 * * *",
		RepoPath: "/tmp/repo",
		Prompt:   "Run all tests",
		Enabled:  1,
	})
	require.NoError(t, err)
	assert.Equal(t, "nightly-tests", job.Name)
	assert.Equal(t, "UTC", job.Timezone)
	assert.Equal(t, 3600, job.MaxDurationS)

	// List
	jobs, err := s.ListScheduledJobs(ctx, false)
	require.NoError(t, err)
	assert.Len(t, jobs, 1)

	// List enabled only
	jobs, err = s.ListScheduledJobs(ctx, true)
	require.NoError(t, err)
	assert.Len(t, jobs, 1)

	// Update
	updated, err := s.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{
		"enabled": false,
	})
	require.NoError(t, err)
	assert.Equal(t, 0, updated.Enabled)

	// Enabled-only should now be empty
	jobs, err = s.ListScheduledJobs(ctx, true)
	require.NoError(t, err)
	assert.Empty(t, jobs)

	// Delete
	err = s.DeleteScheduledJob(ctx, job.ID)
	require.NoError(t, err)
	jobs, _ = s.ListScheduledJobs(ctx, false)
	assert.Empty(t, jobs)
}

func TestScheduledRuns(t *testing.T) {
	db := openTestDB(t)
	s := NewScheduleStore(db)
	ctx := context.Background()

	job, _ := s.CreateScheduledJob(ctx, &ScheduledJob{
		Name: "test-job", CronExpr: "* * * * *",
		RepoPath: "/tmp", Prompt: "test", Enabled: 1,
	})

	// Create run
	runID, err := s.CreateScheduledRun(ctx, job.ID, "2026-01-01T00:00:00Z", "pending")
	require.NoError(t, err)
	assert.Greater(t, runID, int64(0))

	// Get run
	run, err := s.GetScheduledRun(ctx, runID)
	require.NoError(t, err)
	assert.Equal(t, "pending", run.Status)

	// Update run
	err = s.UpdateScheduledRun(ctx, runID, map[string]interface{}{
		"status":     "running",
		"started_at": "2026-01-01T00:01:00Z",
		"session_id": "sess-abc",
	})
	require.NoError(t, err)

	// Active run
	active, err := s.GetActiveRunForJob(ctx, job.ID)
	require.NoError(t, err)
	require.NotNil(t, active)
	assert.Equal(t, "running", active.Status)

	// Running count
	count, err := s.getRunningCount(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// Complete the run
	err = s.UpdateScheduledRun(ctx, runID, map[string]interface{}{
		"status":      "completed",
		"finished_at": "2026-01-01T01:00:00Z",
	})
	require.NoError(t, err)

	// Last run
	lastRun, err := s.GetLastRunForJob(ctx, job.ID)
	require.NoError(t, err)
	assert.Equal(t, "completed", lastRun.Status)

	// All job session IDs
	ids, err := s.getAllJobSessionIDs(ctx)
	require.NoError(t, err)
	assert.True(t, ids["sess-abc"])

	// Recent runs (with job name)
	recent, err := s.ListAllRecentRuns(ctx, 50)
	require.NoError(t, err)
	assert.Len(t, recent, 1)
}

func TestOneshotRuns(t *testing.T) {
	db := openTestDB(t)
	s := NewScheduleStore(db)
	ctx := context.Background()

	displayName := "My Task"
	runID, err := s.CreateOneshotRun(ctx, "2026-01-01T00:00:00Z", &displayName)
	require.NoError(t, err)
	assert.Greater(t, runID, int64(0))

	// List oneshot runs
	runs, err := s.ListOneshotRuns(ctx, 50, nil)
	require.NoError(t, err)
	assert.Len(t, runs, 1)

	// Sentinel job should exist
	sentinelID, err := s.GetOrCreateSentinelJob(ctx)
	require.NoError(t, err)
	assert.Greater(t, sentinelID, int64(0))

	// __oneshot__ should NOT appear in regular job list
	jobs, err := s.ListScheduledJobs(ctx, false)
	require.NoError(t, err)
	assert.Empty(t, jobs) // sentinel excluded
}

// #10021: a run's error text is read by whoever may see the run (Hub viewers included), so the home folder is written as "~" in it, whichever way the text is stored.
func TestRunErrorTextsHideTheHomeFolder(t *testing.T) {
	t.Setenv("HOME", "/home/someone")
	t.Setenv("USERPROFILE", "")
	db := openTestDB(t)
	s := NewScheduleStore(db)
	ws := NewWorkflowStore(db)
	ctx := context.Background()
	const raw, want = "/home/someone/.local/bin/claude is not installed", "~/.local/bin/claude is not installed"

	job, err := s.CreateScheduledJob(ctx, &ScheduledJob{Name: "j", CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	runID, err := s.CreateScheduledRun(ctx, job.ID, "2026-01-01T00:00:00Z", "pending")
	require.NoError(t, err)
	require.NoError(t, s.UpdateScheduledRun(ctx, runID, map[string]interface{}{"status": "failed", "error_msg": raw, "exit_reason": raw}))
	run, err := s.GetScheduledRun(ctx, runID)
	require.NoError(t, err)
	require.NotNil(t, run.ErrorMsg)
	assert.Equal(t, want, *run.ErrorMsg)
	assert.Equal(t, want, *run.ExitReason)

	second, err := s.CreateScheduledRun(ctx, job.ID, "2026-01-02T00:00:00Z", "running")
	require.NoError(t, err)
	ok, err := s.FinishScheduledRunIfActive(ctx, second, "failed", raw, raw, "code", "2026-01-02T00:01:00Z")
	require.NoError(t, err)
	require.True(t, ok)
	run, err = s.GetScheduledRun(ctx, second)
	require.NoError(t, err)
	assert.Equal(t, want, *run.ErrorMsg)
	assert.Equal(t, want, *run.ExitReason)

	wf, err := ws.CreateWorkflow(ctx, &Workflow{Name: "w", StepsJSON: `[{"name":"s","type":"shell","command":"true"}]`, RepoPath: "/tmp", Enabled: 1})
	require.NoError(t, err)
	wr, err := ws.CreateWorkflowRun(ctx, wf.ID, "api", nil)
	require.NoError(t, err)
	msg := raw
	require.NoError(t, ws.SetRunStatus(ctx, wr.ID, "failed", &msg))
	got, err := ws.GetWorkflowRunDirect(ctx, wr.ID)
	require.NoError(t, err)
	require.NotNil(t, got.ErrorMsg)
	assert.Equal(t, want, *got.ErrorMsg)

	// every other write of a workflow run's text: a field update, the sign-in refusal, and the step results' tails and note
	wr2, err := ws.CreateWorkflowRun(ctx, wf.ID, "api", nil)
	require.NoError(t, err)
	require.NoError(t, ws.UpdateWorkflowRun(ctx, wr2.ID, map[string]interface{}{"error_msg": raw}))
	got, err = ws.GetWorkflowRunDirect(ctx, wr2.ID)
	require.NoError(t, err)
	assert.Equal(t, want, *got.ErrorMsg, "UpdateWorkflowRun")
	require.NoError(t, ws.SetRunSignInRefused(ctx, wr2.ID, raw, ErrorCodeNotSignedIn, "claude"))
	got, err = ws.GetWorkflowRunDirect(ctx, wr2.ID)
	require.NoError(t, err)
	assert.Equal(t, want, *got.ErrorMsg, "SetRunSignInRefused")
	results := `[{"index":0,"name":"build","type":"shell","status":"failed","exit_code":127,"output_tail":"ran /home/someone/bin/build\n","error_tail":"bash: /home/someone/x: No such file or directory","note":"refused /home/someone/out.txt","files":[]},{"index":1,"name":"next","type":"shell","status":"pending","files":null}]`
	require.NoError(t, ws.UpdateStepResults(ctx, wr2.ID, 1, results))
	got, err = ws.GetWorkflowRunDirect(ctx, wr2.ID)
	require.NoError(t, err)
	assert.NotContains(t, got.StepResults, "/home/someone", "no step text names the home folder")
	assert.Contains(t, got.StepResults, "bash: ~/x: No such file or directory")
	assert.Contains(t, got.StepResults, "ran ~/bin/build")
	assert.Contains(t, got.StepResults, "refused ~/out.txt")
	assert.Contains(t, got.StepResults, `"exit_code":127`, "the rest of a result is kept")
	assert.Contains(t, got.StepResults, `"files":null`)
	require.NoError(t, ws.UpdateStepResults(ctx, wr2.ID, 1, "not json"))
	got, err = ws.GetWorkflowRunDirect(ctx, wr2.ID)
	require.NoError(t, err)
	assert.Equal(t, "not json", got.StepResults, "a value that is not the results' JSON is stored as it came")
}
