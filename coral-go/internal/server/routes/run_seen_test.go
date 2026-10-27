package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #9315: POST .../seen marks a run as opened for every screen, once; the recent-runs reads carry seen_at; no such run is a 404 and a bad id a 400.
func TestMarkRunSeen(t *testing.T) {
	cfg := config.Load(t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	sh, wh := NewScheduleHandler(db, cfg), NewWorkflowHandler(db, cfg)
	ctx := context.Background()
	job, err := sh.sched.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "j", CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	srun, err := sh.sched.CreateScheduledRun(ctx, job.ID, "2026-10-27T00:00:00Z", "failed")
	require.NoError(t, err)
	wf, err := wh.ws.CreateWorkflow(ctx, &store.Workflow{Name: "w", StepsJSON: `[]`, DefaultAgentJSON: "{}", BaseBranch: "main", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	wrun, err := wh.ws.CreateWorkflowRun(ctx, wf.ID, "api", nil)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Get("/api/scheduled/runs/recent", sh.GetRecentRuns)
	r.Post("/api/scheduled/runs/{runID}/seen", sh.MarkRunSeen)
	r.Get("/api/workflows/runs/recent", wh.ListRecentRuns)
	r.Post("/api/workflows/runs/{runID}/seen", wh.MarkRunSeen)
	do := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}
	has := func(path, key string) bool {
		rec := do(http.MethodGet, path)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return strings.Contains(rec.Body.String(), key)
	}
	assert.False(t, has("/api/scheduled/runs/recent", `"seen_at"`), "an unopened run carries no seen_at")
	assert.False(t, has("/api/workflows/runs/recent", `"seen_at"`))

	id := strconv.FormatInt(srun, 10)
	assert.Equal(t, http.StatusOK, do(http.MethodPost, "/api/scheduled/runs/"+id+"/seen").Code)
	assert.Equal(t, http.StatusOK, do(http.MethodPost, "/api/scheduled/runs/"+id+"/seen").Code, "a second open is fine")
	assert.True(t, has("/api/scheduled/runs/recent", `"seen_at"`), "the read says when")
	wid := strconv.FormatInt(wrun.ID, 10)
	assert.Equal(t, http.StatusOK, do(http.MethodPost, "/api/workflows/runs/"+wid+"/seen").Code)
	assert.True(t, has("/api/workflows/runs/recent", `"seen_at"`))
	assert.Equal(t, http.StatusNotFound, do(http.MethodPost, "/api/scheduled/runs/99999/seen").Code)
	assert.Equal(t, http.StatusNotFound, do(http.MethodPost, "/api/workflows/runs/99999/seen").Code)
	assert.Equal(t, http.StatusBadRequest, do(http.MethodPost, "/api/scheduled/runs/x/seen").Code)
	assert.Equal(t, http.StatusBadRequest, do(http.MethodPost, "/api/workflows/runs/x/seen").Code)
}
