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
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "nightly", CronExpr: "0 9 * * *", Timezone: "UTC", RepoPath: "/tmp", Prompt: "p", JobType: "agent", Enabled: 0})
	require.NoError(t, err)

	assert.Equal(t, http.StatusServiceUnavailable, post("/api/scheduled/jobs/1/run").Code, "no scheduler wired")

	sched := background.NewJobScheduler(ss, time.Minute)
	sched.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error { return nil })
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
