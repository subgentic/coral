package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #9293: POST /api/scheduled/jobs/{jobID}/run starts the job's run now.
func TestRunJobNow(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sched.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewScheduleStore(db)
	h := NewScheduleHandler(db, &config.Config{})
	r := chi.NewRouter()
	r.Post("/api/scheduled/jobs/{jobID}/run", h.RunJob)
	post := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		return rec
	}
	ctx := context.Background()
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "nightly", CronExpr: "0 9 * * *", Timezone: "UTC", RepoPath: "/tmp", Prompt: "p", JobType: "agent", Enabled: 0, NoWorktree: 1}) // no worktree: the folder is not a git repository, and a worktree that cannot be made failed the run within milliseconds, before the second request below (#14280)
	require.NoError(t, err)

	assert.Equal(t, http.StatusServiceUnavailable, post("/api/scheduled/jobs/1/run").Code, "no scheduler wired")

	sched := background.NewJobScheduler(ss, time.Minute)
	// The launch holds until the test ends, so the run stays running while the second request below is made, however long the first takes to answer (a launch that returned at once let the scheduler finish the run in that
	// gap). Cleanups run last in, first out: this one runs before the database is closed (#14280).
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	sched.SetLaunchFn(func(ctx context.Context, _ store.ScheduledJob, _ int64) error {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return nil
	})
	h.SetScheduler(sched)

	rec := post("/api/scheduled/jobs/99999/run")
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, http.StatusBadRequest, post("/api/scheduled/jobs/abc/run").Code)

	rec = post("/api/scheduled/jobs/" + strconv.FormatInt(job.ID, 10) + "/run") // the job is paused: a person asked, it runs
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		RunID  int64  `json:"run_id"`
		JobID  int64  `json:"job_id"`
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, job.ID, out.JobID)
	runs, err := ss.GetRunsForJob(ctx, job.ID, 10)
	require.NoError(t, err)
	require.Len(t, runs, 1, "recorded as the job's run")
	assert.Equal(t, out.RunID, runs[0].ID)
	require.NotNil(t, runs[0].TriggerType)
	assert.Equal(t, "manual", *runs[0].TriggerType)

	assert.Equal(t, http.StatusConflict, post("/api/scheduled/jobs/"+strconv.FormatInt(job.ID, 10)+"/run").Code, "already running")
}
