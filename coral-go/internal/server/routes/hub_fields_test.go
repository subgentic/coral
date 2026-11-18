package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"

	"encoding/json"
	"fmt"
)

// #19570 (coral-hub's design §7.3.3, Security's C5): a request that arrived through the Hub's tunnel gets only the fields of coral-hub's accepted list from every Automations read, whoever the caller (the owner
// included); a request made here keeps every field. The store holds a PRIVATE-<field> sentinel in every field of a job, a workflow (its steps' prompts and commands too) and their runs.

const hubSentinel = "PRIVATE-"

// keyPaths is every key path of a decoded reply, arrays as [].
func keyPaths(v any, prefix string, out map[string]bool) {
	switch t := v.(type) {
	case map[string]any:
		for k, c := range t {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			out[p] = true
			keyPaths(c, p, out)
		}
	case []any:
		for _, c := range t {
			keyPaths(c, prefix+"[]", out)
		}
	}
}

func hubPathList(m map[string]bool) []string {
	var s []string
	for k := range m {
		s = append(s, k)
	}
	sort.Strings(s)
	return s
}

type hubFieldsRig struct {
	f      *runsFixture
	router chi.Router
	job    int64
	wf     int64
	jobRun int64
	wfRun  int64
}

const hubOwnerUser = "hub-user-1234abcd"

func newHubFieldsRig(t *testing.T) *hubFieldsRig {
	t.Helper()
	f := newRunsFixture(t)
	SetHubOwnerLabel(func(context.Context) (string, error) { return hubOwnerUser, nil })
	t.Cleanup(func() { SetHubOwnerLabel(nil) })
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		_, err := f.db.ExecContext(ctx, q, args...)
		require.NoError(t, err)
	}
	j, err := f.sh.sched.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "nightly-report", Description: hubSentinel + "description", CronExpr: "0 3 * * *", Timezone: "UTC",
		AgentType: hubSentinel + "agent_type", RepoPath: hubSentinel + "repo_path", BaseBranch: hubSentinel + "base_branch", Prompt: hubSentinel + "prompt", Flags: hubSentinel + "flags", Enabled: 1, TeamName: hubSentinel + "team_name"})
	require.NoError(t, err)
	exec(`UPDATE scheduled_jobs SET paused_reason = ? WHERE id = ?`, hubSentinel+"paused_reason", j.ID)
	runID, err := f.sh.sched.CreateScheduledRunTrigger(ctx, j.ID, "2026-11-17T03:00:00Z", "failed", "cron")
	require.NoError(t, err)
	exec(`UPDATE scheduled_runs SET session_id = ?, worktree_path = ?, started_at = ?, finished_at = ?, exit_reason = ?, error_msg = ?, error_code = ?, agent_type = ?, result_text = ?, display_name = ? WHERE id = ?`,
		hubSentinel+"session_id", hubSentinel+"worktree_path", "2026-11-17T03:00:01Z", "2026-11-17T03:05:00Z", hubSentinel+"exit_reason", hubSentinel+"error_msg", "not_signed_in", hubSentinel+"agent_type", hubSentinel+"result_text", "Nightly report", runID)
	steps := `[{"name":"` + hubSentinel + `step_name","prompt":"` + hubSentinel + `step_prompt","command":"` + hubSentinel + `step_command","files":["` + hubSentinel + `step_files"]}]`
	wf, err := f.wh.ws.CreateWorkflow(ctx, &store.Workflow{Name: "nightly-build", Description: hubSentinel + "wf_description", StepsJSON: steps, DefaultAgentJSON: `{"agent":"` + hubSentinel + `default_agent"}`,
		RepoPath: hubSentinel + "wf_repo_path", BaseBranch: hubSentinel + "wf_base_branch", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	tc := hubSentinel + "trigger_context"
	wr, err := f.wh.ws.CreateWorkflowRun(ctx, wf.ID, "manual", &tc)
	require.NoError(t, err)
	exec(`UPDATE workflow_runs SET status = 'failed', started_at = ?, finished_at = ?, error_msg = ?, worktree_path = ?, error_code = ?, agent_type = ?, step_results = ? WHERE id = ?`,
		"2026-11-17T04:00:00Z", "2026-11-17T04:01:00Z", hubSentinel+"wf_error_msg", hubSentinel+"wf_worktree_path", "not_signed_in", hubSentinel+"wf_agent_type",
		`[{"index":0,"name":"`+hubSentinel+`step_name","status":"failed","exit_code":1,"output_tail":"`+hubSentinel+`output_tail","error_tail":"`+hubSentinel+`error_tail","files":["`+hubSentinel+`file"]}]`, wr.ID)
	r := chi.NewRouter()
	r.With(HubJobs).Get("/api/scheduled/jobs", f.sh.ListJobs)
	r.With(HubJob).Get("/api/scheduled/jobs/{jobID}", f.sh.GetJob)
	r.With(HubRuns).Get("/api/scheduled/jobs/{jobID}/runs", f.sh.GetJobRuns)
	r.With(HubRuns).Get("/api/scheduled/runs/recent", f.sh.GetRecentRuns)
	r.With(HubRuns).Get("/api/automations/runs", f.sh.AutomationRuns)
	r.With(HubWorkflows).Get("/api/workflows", f.wh.ListWorkflows)
	r.With(HubRuns).Get("/api/workflows/runs/recent", f.wh.ListRecentRuns)
	r.With(HubWorkflow).Get("/api/workflows/by-name/{name}", f.wh.GetWorkflowByName)
	r.With(HubWorkflow).Get("/api/workflows/{workflowID}", f.wh.GetWorkflow)
	r.With(HubRuns).Get("/api/workflows/{workflowID}/runs", f.wh.ListWorkflowRuns)
	r.With(HubRun).Get("/api/workflows/runs/{runID}", f.wh.GetWorkflowRun)
	return &hubFieldsRig{f: f, router: r, job: j.ID, wf: wf.ID, jobRun: runID, wfRun: wr.ID}
}

func (g *hubFieldsRig) get(t *testing.T, path string, tunneled bool) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if tunneled {
		req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		req.Header.Set(tunnel.HubRoleHeader, "owner") // the owner is cut too
		req.Header.Set(tunnel.HubUserHeader, hubOwnerUser)
	}
	rec := httptest.NewRecorder()
	g.router.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestAutomationReadsThroughTheTunnelKeepOnlyTheAcceptedFields(t *testing.T) {
	g := newHubFieldsRig(t)
	run := []string{"kind", "id", "job_name", "display_name", "workflow_name", "status", "trigger_type", "scheduled_at", "started_at", "finished_at", "duration_seconds", "error_code", "failed_step", "failed_step.number"}
	under := func(prefix string, fields ...string) []string {
		var out []string
		for _, f := range fields {
			out = append(out, prefix+f)
		}
		return out
	}
	jobFields := []string{"id", "name", "enabled", "paused", "cron_expr", "timezone", "next_fire_at", "consecutive_failures", "last_run", "last_run.status", "last_run.started_at", "last_run.finished_at", "last_run.error_code"}
	wfFields := []string{"id", "name", "enabled", "step_count", "last_run", "last_run.status", "last_run.trigger_type", "last_run.started_at", "last_run.finished_at", "last_run.failed_step", "last_run.failed_step.number"}
	// every route, the key paths the tunnel reply may hold (allowed), and those it must hold for this store (exact where the store fills them all)
	cases := []struct {
		name, path string
		exact      []string
		allowed    []string
	}{
		{"jobs", "/api/scheduled/jobs", append([]string{"jobs"}, under("jobs[].", jobFields...)...), nil},
		{"one job", fmt.Sprintf("/api/scheduled/jobs/%d", g.job), nil, jobFields},
		{"a job's runs", fmt.Sprintf("/api/scheduled/jobs/%d/runs", g.job), nil, append([]string{"runs", "total"}, under("runs[].", run...)...)},
		{"recent job runs", "/api/scheduled/runs/recent", nil, append([]string{"runs"}, under("runs[].", run...)...)},
		{"automation runs", "/api/automations/runs", nil, append([]string{"runs", "total", "has_more"}, under("runs[].", run...)...)},
		{"workflows", "/api/workflows", append([]string{"workflows"}, under("workflows[].", wfFields...)...), nil},
		{"one workflow", fmt.Sprintf("/api/workflows/%d", g.wf), nil, wfFields},
		{"a workflow by name", "/api/workflows/by-name/nightly-build", nil, wfFields},
		{"a workflow's runs", fmt.Sprintf("/api/workflows/%d/runs", g.wf), nil, append([]string{"runs", "total"}, under("runs[].", run...)...)},
		{"recent workflow runs", "/api/workflows/runs/recent", nil, append([]string{"runs"}, under("runs[].", run...)...)},
		{"one workflow run", fmt.Sprintf("/api/workflows/runs/%d", g.wfRun), nil, run},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			code, local := g.get(t, c.path, false)
			require.Equal(t, http.StatusOK, code, local)
			code, tun := g.get(t, c.path, true)
			require.Equal(t, http.StatusOK, code, tun)
			assert.Contains(t, local, hubSentinel, "a request made here keeps every field, sentinels included")
			assert.NotContains(t, tun, hubSentinel, "no PRIVATE field crosses the tunnel")
			var decoded any
			require.NoError(t, json.Unmarshal([]byte(tun), &decoded))
			got := map[string]bool{}
			keyPaths(decoded, "", got)
			if c.exact != nil {
				want := map[string]bool{}
				for _, k := range c.exact {
					want[k] = true
				}
				assert.Equal(t, hubPathList(want), hubPathList(got), "the tunnel key set is the allow-list")
			}
			if c.allowed != nil {
				ok := map[string]bool{}
				for _, k := range c.allowed {
					ok[k] = true
				}
				for k := range got {
					assert.True(t, ok[k], "%s: %q is not in the allow-list", c.name, k)
				}
			}
			assert.NotEmpty(t, got, "the reply is not empty")
		})
	}
}

// A field added to a job, a workflow or a run later is left out by default: the cut names what stays.
func TestAFieldNobodyListedIsLeftOutOfATunnelReply(t *testing.T) {
	reply := `{"jobs":[{"id":1,"name":"n","prompt":"PRIVATE","brand_new":"PRIVATE","last_run":{"status":"failed","new_run_field":"PRIVATE"}}],"extra":"PRIVATE"}`
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(reply), &m))
	b, _ := json.Marshal(hubJobsList(m))
	assert.NotContains(t, string(b), "PRIVATE")
	assert.Contains(t, string(b), `"name":"n"`)
}

// The paused flag says whether, never why; an error code that is not a fixed word is dropped to "".
func TestThePausedTextAndAFreeFormErrorCodeNeverCross(t *testing.T) {
	m := map[string]any{"id": 1.0, "paused_reason": "PRIVATE reason", "last_run": map[string]any{"status": "failed", "error_code": "PRIVATE free text"}}
	out := hubJob(m)
	assert.Equal(t, true, out["paused"])
	assert.NotContains(t, out, "paused_reason")
	assert.Equal(t, "", out["last_run"].(map[string]any)["error_code"])
	assert.Equal(t, false, hubJob(map[string]any{"paused_reason": ""})["paused"])
}

// Not JSON, or an error body: nothing unlisted is passed on; an error keeps its status and its message.
func TestATunnelErrorReplyKeepsItsStatusAndMessageOnly(t *testing.T) {
	g := newHubFieldsRig(t)
	code, body := g.get(t, "/api/scheduled/jobs/99999", true)
	assert.Equal(t, http.StatusNotFound, code)
	assert.Contains(t, body, "job not found")
}

// router.go registers each Automations read with its cut: dropping one would send the full reply through the Hub.
func TestEveryAutomationReadIsRegisteredWithItsHubCut(t *testing.T) {
	src, err := os.ReadFile("../router.go")
	require.NoError(t, err)
	for route, cut := range map[string]string{
		`"/api/scheduled/jobs", schedHandler.ListJobs`:                         "HubJobs",
		`"/api/scheduled/jobs/{jobID}", schedHandler.GetJob`:                   "HubJob",
		`"/api/scheduled/jobs/{jobID}/runs", schedHandler.GetJobRuns`:          "HubRuns",
		`"/api/scheduled/runs/recent", schedHandler.GetRecentRuns`:             "HubRuns",
		`"/api/automations/runs", schedHandler.AutomationRuns`:                 "HubRuns",
		`"/api/workflows", workflowHandler.ListWorkflows`:                      "HubWorkflows",
		`"/api/workflows/runs/recent", workflowHandler.ListRecentRuns`:         "HubRuns",
		`"/api/workflows/by-name/{name}", workflowHandler.GetWorkflowByName`:   "HubWorkflow",
		`"/api/workflows/{workflowID}", workflowHandler.GetWorkflow`:           "HubWorkflow",
		`"/api/workflows/{workflowID}/runs", workflowHandler.ListWorkflowRuns`: "HubRuns",
		`"/api/workflows/runs/{runID}", workflowHandler.GetWorkflowRun`:        "HubRun",
	} {
		found := false
		for _, line := range strings.Split(string(src), "\n") {
			if strings.Contains(line, `.Get(`+route+`)`) {
				found = true
				assert.Contains(t, line, "r.With(routes."+cut+").Get(", route)
			}
		}
		assert.True(t, found, route)
	}
}
