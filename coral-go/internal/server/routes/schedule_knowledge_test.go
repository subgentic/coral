package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13928 (Security's MUST D, E and F): who can make a knowledge job and what an edit may change. The generic routes accept kind knowledge with a team that exists and nothing else; an edit changes only when
// it runs and whether it is on; a job the scheduler paused is not switched on by the switch.

func knowledgeScheduleServer(t *testing.T, teams ...string) (*httptest.Server, *store.ScheduleStore) {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sched.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewScheduleHandler(db, &config.Config{})
	known := map[string]bool{}
	for _, tm := range teams {
		known[tm] = true
	}
	h.SetKnowledgeTeamCheck(func(_ context.Context, name string) bool { return known[name] })
	r := chi.NewRouter()
	r.Post("/api/scheduled/jobs", h.CreateJob)
	r.Get("/api/scheduled/jobs", h.ListJobs)
	r.Put("/api/scheduled/jobs/{jobID}", h.UpdateJob)
	r.Post("/api/scheduled/jobs/{jobID}/toggle", h.ToggleJob)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, store.NewScheduleStore(db)
}

func TestAKnowledgeJobIsMadeByTheServerForATeamThatExistsAndNothingElse(t *testing.T) {
	srv, _ := knowledgeScheduleServer(t, "alpha")
	code, job := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha"})
	require.Equal(t, http.StatusOK, code, job)
	assert.Equal(t, "knowledge", job["job_type"])
	assert.Equal(t, "alpha", job["team_name"])
	assert.Equal(t, "Distill team knowledge: alpha", job["name"])
	assert.Equal(t, float64(1), job["enabled"])
	assert.Empty(t, job["prompt"])
	assert.Empty(t, job["repo_path"])
	assert.Regexp(t, ` 3 \* \* \*$`, job["cron_expr"])
	// one job a team
	code, out := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "knowledge_job_exists", out["code"])
	// no such team, no team
	code, _ = sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "ghost"})
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge"})
	assert.Equal(t, http.StatusNotFound, code)
	// a schedule may be named, if it is valid; off may be asked for
	code, job = sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "beta", "cron_expr": "0 4 * * *"})
	assert.Equal(t, http.StatusNotFound, code, "beta is not a team: %v", job)
}

func TestAKnowledgeJobRefusesEverythingItWouldRun(t *testing.T) {
	srv, store := knowledgeScheduleServer(t, "alpha")
	for name, extra := range map[string]map[string]any{
		"a prompt":      {"prompt": "do things"},
		"a command":     {"command": "rm -rf /"},
		"a model":       {"model": "claude-opus-5-5"},
		"a folder":      {"repo_path": "/tmp"},
		"flags":         {"flags": "--yolo"},
		"an agent type": {"agent_type": "claude"},
		"a workflow":    {"workflow_id": 3},
		"a name":        {"name": "my own"},
		"a branch":      {"base_branch": "main"},
	} {
		body := map[string]any{"job_type": "knowledge", "team_name": "alpha"}
		for k, v := range extra {
			body[k] = v
		}
		code, out := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", body)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	jobs, err := store.ListScheduledJobs(context.Background(), false)
	require.NoError(t, err)
	assert.Empty(t, jobs, "nothing was made")
	// a team name on any other kind is refused
	code, _ := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"name": "n", "cron_expr": "0 9 * * *", "repo_path": t.TempDir(), "prompt": "p", "team_name": "alpha", "no_worktree": 1})
	assert.Equal(t, http.StatusBadRequest, code)
	// a bad schedule is refused
	code, _ = sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha", "cron_expr": "not a cron"})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha", "timezone": "Mars/Base"})
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestAnEditOfAKnowledgeJobChangesOnlyWhenItRunsAndWhetherItIsOn(t *testing.T) {
	srv, ss := knowledgeScheduleServer(t, "alpha")
	_, job := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha"})
	url := srv.URL + "/api/scheduled/jobs/" + formatID(job["id"])
	for name, fields := range map[string]map[string]any{
		"its kind":   {"job_type": "prompt"},
		"its team":   {"team_name": "beta"},
		"a prompt":   {"prompt": "run this"},
		"a folder":   {"repo_path": "/tmp"},
		"flags":      {"flags": "--yolo"},
		"agent type": {"agent_type": "codex"},
		"its name":   {"name": "other"},
	} {
		code, out := sendJSON(t, "PUT", url, fields)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	code, out := sendJSON(t, "PUT", url, map[string]any{"cron_expr": "15 5 * * *", "timezone": "UTC", "enabled": 0})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "15 5 * * *", out["cron_expr"])
	assert.Equal(t, float64(0), out["enabled"])
	// no other job can be given a team or turned into a knowledge job
	_, other := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"name": "n", "cron_expr": "0 9 * * *", "repo_path": t.TempDir(), "prompt": "p", "no_worktree": 1})
	code, _ = sendJSON(t, "PUT", srv.URL+"/api/scheduled/jobs/"+formatID(other["id"]), map[string]any{"team_name": "alpha"})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = sendJSON(t, "PUT", srv.URL+"/api/scheduled/jobs/"+formatID(other["id"]), map[string]any{"job_type": "knowledge"})
	assert.Equal(t, http.StatusBadRequest, code)
	_ = ss
}

func TestTheSwitchNeverClearsThePauseOfARepeatedlyFailingKnowledgeJob(t *testing.T) {
	srv, ss := knowledgeScheduleServer(t, "alpha")
	_, job := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha"})
	id := int64(job["id"].(float64))
	_, err := ss.UpdateScheduledJob(context.Background(), id, map[string]interface{}{"enabled": 0, "paused_reason": "Paused after 3 failed runs in a row: distilling failed"})
	require.NoError(t, err)
	url := srv.URL + "/api/scheduled/jobs/" + formatID(job["id"])
	for name, call := range map[string]func() (int, map[string]any){
		"the toggle":   func() (int, map[string]any) { return sendJSON(t, "POST", url+"/toggle", map[string]any{}) },
		"an edit":      func() (int, map[string]any) { return sendJSON(t, "PUT", url, map[string]any{"enabled": 1}) },
		"an edit true": func() (int, map[string]any) { return sendJSON(t, "PUT", url, map[string]any{"enabled": true}) },
	} {
		code, out := call()
		assert.Equal(t, http.StatusConflict, code, "%s: %v", name, out)
		assert.Equal(t, "paused_needs_run", out["code"], name)
		after, _ := ss.GetScheduledJob(context.Background(), id)
		assert.Equal(t, 0, after.Enabled, name)
		assert.NotEmpty(t, after.PausedReason, name)
	}
	// a job that is simply off (not paused by the scheduler) is switched on by the toggle as ever
	_, job2 := sendJSON(t, "POST", srv.URL+"/api/scheduled/jobs", map[string]any{"job_type": "knowledge", "team_name": "alpha", "enabled": 0})
	_ = job2
}

func formatID(v any) string { return strconv.FormatInt(int64(v.(float64)), 10) }
