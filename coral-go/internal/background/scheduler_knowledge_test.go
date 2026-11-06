package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13928: a "knowledge" job is the fourth job kind. No agent is started; the run row ends with the body's fixed words and code.

func knowledgeJobFixture(t *testing.T) (*JobScheduler, *store.ScheduleStore, store.ScheduledJob) {
	t.Helper()
	ss := store.NewScheduleStore(setupTestDB(t))
	nj := NewKnowledgeJob("team-k")
	job, err := ss.CreateScheduledJob(context.Background(), &nj)
	require.NoError(t, err)
	s := NewJobScheduler(ss, time.Minute)
	s.SetNextFireTimeFn(NextFireTime)
	s.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error {
		t.Error("a knowledge job starts no agent")
		return nil
	})
	return s, ss, *job
}

func finishedRun(t *testing.T, s *JobScheduler, ss *store.ScheduleStore, runID int64) *store.ScheduledRun {
	t.Helper()
	s.watching.Wait()
	run, err := ss.GetScheduledRun(context.Background(), runID)
	require.NoError(t, err)
	return run
}

func TestTheServerBuildsTheKnowledgeJobItself(t *testing.T) {
	j := NewKnowledgeJob("my-team")
	assert.Equal(t, "knowledge", j.JobType)
	assert.Equal(t, "my-team", j.TeamName)
	assert.Equal(t, 1, j.Enabled)
	assert.Empty(t, j.Prompt)
	assert.Empty(t, j.RepoPath)
	assert.Empty(t, j.Flags)
	assert.Regexp(t, `^(3\d|4\d|5\d) 3 \* \* \*$`, j.CronExpr, "03:30 to 03:59, a minute of the team's own")
	assert.Equal(t, NewKnowledgeJob("my-team").CronExpr, j.CronExpr, "the same team always gets the same minute")
}

func TestAKnowledgeRunEndsWithTheBodysWordsAndCode(t *testing.T) {
	ctx := context.Background()
	for name, res := range map[string]AutoResult{
		"completed": {State: "completed", Reason: "distilled 2 agents, about 900 tokens; a candidate is waiting for a person to accept"},
		"skipped":   {State: "completed", Reason: "skipped: nothing new since the last run"},
		"failed":    {State: "failed", Reason: "the agent CLI is signed out", Code: AutoCodeNotSignedIn},
	} {
		t.Run(name, func(t *testing.T) {
			s, ss, job := knowledgeJobFixture(t)
			var ranFor string
			s.SetKnowledgeRunFn(func(_ context.Context, j store.ScheduledJob, _ int64) AutoResult { ranFor = j.TeamName; return res })
			id, err := s.RunNow(ctx, job.ID)
			require.NoError(t, err)
			run := finishedRun(t, s, ss, id)
			assert.Equal(t, "team-k", ranFor)
			assert.Equal(t, res.State, run.Status)
			require.NotNil(t, run.ExitReason)
			assert.Equal(t, res.Reason, *run.ExitReason)
			if res.Code != "" {
				require.NotNil(t, run.ErrorCode)
				assert.Equal(t, res.Code, *run.ErrorCode)
				require.NotNil(t, run.ErrorMsg)
				assert.Equal(t, res.Reason, *run.ErrorMsg)
			}
		})
	}
}

func TestAKnowledgeJobWithNoBodyFailsInFixedWords(t *testing.T) {
	s, ss, job := knowledgeJobFixture(t)
	id, err := s.RunNow(context.Background(), job.ID)
	require.NoError(t, err)
	run := finishedRun(t, s, ss, id)
	assert.Equal(t, "failed", run.Status)
	require.NotNil(t, run.ErrorMsg)
	assert.Equal(t, "distilling is unavailable", *run.ErrorMsg)
}

// A job the scheduler paused after three failures is resumed by a good manual run, not by a good scheduled one (and not by the switch: the route refuses that).
func TestOnlyAGoodManualRunResumesAPausedKnowledgeJob(t *testing.T) {
	ctx := context.Background()
	good := AutoResult{State: "completed", Reason: "skipped: nothing new since the last run"}
	for trigger, resumes := range map[string]bool{store.TriggerManual: true, store.TriggerCron: false} {
		s, ss, job := knowledgeJobFixture(t)
		s.SetKnowledgeRunFn(func(context.Context, store.ScheduledJob, int64) AutoResult { return good })
		_, err := ss.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"enabled": 0, "paused_reason": "Paused after 3 failed runs in a row: distilling failed"})
		require.NoError(t, err)
		paused, _ := ss.GetScheduledJob(ctx, job.ID)
		id, err := s.startRun(ctx, *paused, time.Now().UTC(), trigger)
		require.NoError(t, err)
		finishedRun(t, s, ss, id)
		after, _ := ss.GetScheduledJob(ctx, job.ID)
		if resumes {
			assert.Equal(t, 1, after.Enabled, trigger)
			assert.Empty(t, after.PausedReason, trigger)
		} else {
			assert.Equal(t, 0, after.Enabled, trigger)
			assert.NotEmpty(t, after.PausedReason, trigger)
		}
	}
}

func TestAKnowledgeRunTheServerStoppedInIsEndedAtStartup(t *testing.T) {
	ctx := context.Background()
	s, ss, job := knowledgeJobFixture(t)
	runID, err := ss.CreateScheduledRunTrigger(ctx, job.ID, time.Now().UTC().Format(store.ISOFormat), "running", store.TriggerCron)
	require.NoError(t, err)
	s.reapStaleRuns(ctx)
	run, err := ss.GetScheduledRun(ctx, runID)
	require.NoError(t, err)
	assert.Equal(t, "failed", run.Status)
	require.NotNil(t, run.ErrorMsg)
	assert.Equal(t, "the server stopped during the run", *run.ErrorMsg)
}
