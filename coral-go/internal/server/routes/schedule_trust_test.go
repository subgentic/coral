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
	"github.com/subgentic/coral/pkg/tunnel"
)

// #16421, Security's conditions on a job's "Trust this folder" box. The caller is chosen by the X-Test-Caller header.

func trustJobServer(t *testing.T) (*httptest.Server, *store.ScheduleStore) {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sched.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewScheduleHandler(db, &config.Config{})
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			switch req.Header.Get("X-Test-Caller") {
			case "dash":
				req = asCaller(callerDashCookie)(req)
			case "agent":
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "11111111-2222-4333-8444-555555555555", SessionName: "claude-11111111-2222-4333-8444-555555555555"}))
			case "hub":
				req.Header.Set(tunnel.ViaHeader, "x")
				req = asCaller(callerHubOwner)(req)
			case "cli":
				req = asCaller(callerCLISigned)(req)
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/scheduled/jobs", h.CreateJob)
	r.Get("/api/scheduled/jobs/{jobID}", h.GetJob)
	r.Put("/api/scheduled/jobs/{jobID}", h.UpdateJob)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, store.NewScheduleStore(db)
}

func callAs(t *testing.T, caller, method, url string, body any) (int, map[string]any) {
	t.Helper()
	return sendJSONHeader(t, method, url, body, map[string]string{"X-Test-Caller": caller})
}

func newJob(repo string, extra map[string]any) map[string]any {
	m := map[string]any{"name": "nightly", "cron_expr": "0 9 * * *", "repo_path": repo, "prompt": "p"}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func jobTrust(t *testing.T, st *store.ScheduleStore, id float64) int {
	t.Helper()
	j, err := st.GetScheduledJob(context.Background(), int64(id))
	require.NoError(t, err)
	require.NotNil(t, j)
	return j.TrustWorktree
}

func TestAJobStartsWithTheTrustBoxOff(t *testing.T) {
	srv, st := trustJobServer(t)
	code, out := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(gitRepo(t), nil))
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Zero(t, jobTrust(t, st, out["id"].(float64)), "the box is off unless the person ticks it")
}

func TestOnlyThePersonsOwnDashboardTicksAJobsTrustBox(t *testing.T) {
	srv, st := trustJobServer(t)
	repo := gitRepo(t)
	for _, caller := range []string{"agent", "hub", "cli", ""} {
		code, out := callAs(t, caller, http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, map[string]any{"name": "t-" + caller, "trust_worktree": 1}))
		assert.Equal(t, http.StatusForbidden, code, "create as %q: %v", caller, out)
	}
	jobs, _ := st.ListScheduledJobs(context.Background(), false)
	assert.Empty(t, jobs, "a refused create made no job")

	code, out := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, map[string]any{"trust_worktree": 1}))
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := out["id"].(float64)
	assert.Equal(t, 1, jobTrust(t, st, id), "the person's dashboard may")

	// An update: an agent, the Hub and the CLI cannot tick it on another job; any caller may turn it off.
	_, plain := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, map[string]any{"name": "plain"}))
	pid := plain["id"].(float64)
	url := srv.URL + "/api/scheduled/jobs/" + strconv.Itoa(int(pid))
	for _, caller := range []string{"agent", "hub", "cli", ""} {
		code, _ := callAs(t, caller, http.MethodPut, url, map[string]any{"trust_worktree": 1})
		assert.Equal(t, http.StatusForbidden, code, "update as %q", caller)
	}
	assert.Zero(t, jobTrust(t, st, pid))
	code, _ = callAs(t, "agent", http.MethodPut, srv.URL+"/api/scheduled/jobs/"+strconv.Itoa(int(id)), map[string]any{"trust_worktree": 0})
	assert.Equal(t, http.StatusOK, code)
	assert.Zero(t, jobTrust(t, st, id), "an agent may turn it off")
}

func TestTheTrustBoxIsClearedWhenTheJobsFolderOrWayOfRunningChanges(t *testing.T) {
	srv, st := trustJobServer(t)
	repo, other := gitRepo(t), gitRepo(t)
	mk := func(name string) (float64, string) {
		code, out := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, map[string]any{"name": name, "trust_worktree": 1}))
		require.Equal(t, http.StatusOK, code, "%v", out)
		id := out["id"].(float64)
		require.Equal(t, 1, jobTrust(t, st, id))
		return id, srv.URL + "/api/scheduled/jobs/" + strconv.Itoa(int(id))
	}

	id, url := mk("rename")
	code, _ := callAs(t, "dash", http.MethodPut, url, map[string]any{"name": "renamed"})
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, 1, jobTrust(t, st, id), "an unrelated edit keeps the box")

	for _, caller := range []string{"dash", "agent"} {
		id, url = mk("repo-" + caller)
		code, _ = callAs(t, caller, http.MethodPut, url, map[string]any{"repo_path": other})
		require.Equal(t, http.StatusOK, code)
		assert.Zero(t, jobTrust(t, st, id), "a new folder clears the box (%s's edit)", caller)
	}

	id, url = mk("again")
	code, _ = callAs(t, "dash", http.MethodPut, url, map[string]any{"repo_path": other, "trust_worktree": 1})
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, 1, jobTrust(t, st, id), "the person's own save may tick it again for the new folder")

	id, url = mk("nowt")
	code, _ = callAs(t, "dash", http.MethodPut, url, map[string]any{"no_worktree": 1})
	require.Equal(t, http.StatusOK, code)
	assert.Zero(t, jobTrust(t, st, id), "a job that runs in its folder itself has no worktree to trust")

	id, url = mk("agenttype")
	code, _ = callAs(t, "dash", http.MethodPut, url, map[string]any{"agent_type": "gemini"})
	require.Equal(t, http.StatusOK, code)
	assert.Zero(t, jobTrust(t, st, id), "an agent with no card Coral can set loses it")
}

func TestTheTrustBoxIsOnlyForAWorktreeJobOfClaudeOrCodex(t *testing.T) {
	srv, _ := trustJobServer(t)
	repo := gitRepo(t)
	for name, extra := range map[string]map[string]any{
		"no worktree":  {"no_worktree": 1},
		"a gemini job": {"agent_type": "gemini"},
		"not 0 or 1":   {"trust_worktree": 2},
	} {
		body := map[string]any{"trust_worktree": 1}
		for k, v := range extra {
			body[k] = v
		}
		code, out := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, body))
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	code, out := callAs(t, "dash", http.MethodPost, srv.URL+"/api/scheduled/jobs", newJob(repo, map[string]any{"trust_worktree": 1, "agent_type": "codex"}))
	assert.Equal(t, http.StatusOK, code, "a Codex job may: %v", out)
}
