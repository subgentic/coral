package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// A job's and a workflow's run history is read a page at a time, and says how many runs there are, so a page can say "20 of 142" and the next can be asked for (#8089: the pages showed
// the newest 20 and 10 and said nothing about the rest).
func TestRunListsSayTheTotalAndPage(t *testing.T) {
	ctx := context.Background()
	cfg := config.Load(t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	sh, wh := NewScheduleHandler(db, cfg), NewWorkflowHandler(db, cfg)
	job, err := sh.sched.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "j", CronExpr: "0 * * * *", Timezone: "UTC", AgentType: "claude", RepoPath: "/r", Prompt: "p", Enabled: 1, MaxDurationS: 60, CleanupWorktree: 1})
	require.NoError(t, err)
	wf, err := wh.ws.CreateWorkflow(ctx, &store.Workflow{Name: "w", StepsJSON: `[]`, DefaultAgentJSON: "{}", BaseBranch: "main", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	for i := 0; i < 25; i++ {
		_, err = sh.sched.CreateScheduledRun(ctx, job.ID, fmt.Sprintf("2026-10-15T10:%02d:00Z", i), "completed")
		require.NoError(t, err)
		_, err = wh.ws.CreateWorkflowRun(ctx, wf.ID, "manual", nil)
		require.NoError(t, err)
	}
	r := chi.NewRouter()
	r.Get("/api/scheduled/jobs/{jobID}/runs", sh.GetJobRuns)
	r.Get("/api/workflows/{workflowID}/runs", wh.ListWorkflowRuns)
	get := func(path string) (runs []map[string]any, total float64) {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out struct {
			Runs  []map[string]any `json:"runs"`
			Total float64          `json:"total"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out.Runs, out.Total
	}
	for _, base := range []string{fmt.Sprintf("/api/scheduled/jobs/%d/runs", job.ID), fmt.Sprintf("/api/workflows/%d/runs", wf.ID)} {
		first, total := get(base + "?limit=10")
		assert.EqualValues(t, 25, total, base)
		assert.Len(t, first, 10, base)
		ids := map[float64]bool{}
		for _, off := range []int{0, 10, 20} {
			page, tot := get(fmt.Sprintf("%s?limit=10&offset=%d", base, off))
			assert.EqualValues(t, 25, tot, base)
			for _, run := range page {
				assert.False(t, ids[run["id"].(float64)], "%s: run %v on two pages", base, run["id"])
				ids[run["id"].(float64)] = true
			}
		}
		assert.Len(t, ids, 25, "%s: every run is on some page", base)
		last, _ := get(base + "?limit=10&offset=20")
		assert.Len(t, last, 5, base)
	}
}
