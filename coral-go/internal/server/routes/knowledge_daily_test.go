package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13928: the switch, the status, the waiting candidate with its diff, accept and revert. A person's writes only; the body of the switch is {enabled} and nothing else.

type dailyRig struct {
	t   *testing.T
	srv *httptest.Server
	h   *SessionsHandler
	ss  *store.SessionStore
	dir string
}

func newDailyRig(t *testing.T) *dailyRig {
	t.Helper()
	base, h, _, ss := setupSessionsTestServer(t)
	_ = base
	if h.teamStore == nil {
		h.teamStore = store.NewTeamStore(h.db)
	}
	board := "alpha"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "dddddddd-0001", AgentType: "claude", AgentName: "Lead", WorkingDir: t.TempDir(), BoardName: &board}))
	rt := chi.NewRouter()
	rt.Use(testIdentity(h.db))
	rt.Get("/api/teams/detail/{name}/daily-knowledge", h.DailyKnowledgeStatus)
	rt.Put("/api/teams/detail/{name}/daily-knowledge", h.SetDailyKnowledge)
	rt.Put("/api/teams/detail/{name}/daily-knowledge/auto-apply", h.SetDailyKnowledgeAutoApply)
	rt.Post("/api/teams/detail/{name}/daily-knowledge/accept", h.AcceptDailyKnowledge)
	rt.Post("/api/teams/detail/{name}/daily-knowledge/revert", h.RevertDailyKnowledge)
	own := httptest.NewServer(rt)
	t.Cleanup(own.Close)
	return &dailyRig{t: t, srv: own, h: h, ss: ss, dir: h.cfg.CoralDir()}
}

func (r *dailyRig) call(method, path, body string, agent bool) (int, map[string]any) {
	r.t.Helper()
	req, _ := http.NewRequest(method, r.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if agent {
		req.Header.Set(testAgentHeader, "dddddddd-0001")
	}
	resp, err := operatorClient.Do(req)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

const dailyBase = "/api/teams/detail/alpha/daily-knowledge"

func TestTheDailySwitchMakesAndSwitchesTheTeamsOneJob(t *testing.T) {
	r := newDailyRig(t)
	code, out := r.call("GET", dailyBase, "", false)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["enabled"])
	assert.Equal(t, false, out["job"])
	assert.Equal(t, false, out["auto_apply"], "applying by itself is off until the Operator says so")
	code, out = r.call("PUT", dailyBase, `{"enabled":true}`, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["enabled"])
	assert.Equal(t, true, out["job"])
	assert.Regexp(t, ` 3 \* \* \*$`, out["cron_expr"])
	assert.NotEmpty(t, out["next_run_at"])
	jobID := out["job_id"]
	code, out = r.call("PUT", dailyBase, `{"enabled":false}`, false)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["enabled"])
	assert.Equal(t, jobID, out["job_id"], "the same job")
	code, out = r.call("PUT", dailyBase, `{"enabled":true}`, false)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["enabled"])
	assert.Equal(t, jobID, out["job_id"], "switched on again, not made twice")
	jobs, err := store.NewScheduleStore(r.h.db).ListScheduledJobs(context.Background(), false)
	require.NoError(t, err)
	assert.Len(t, jobs, 1)
	assert.Equal(t, "knowledge", jobs[0].JobType)
	assert.Equal(t, "alpha", jobs[0].TeamName)
}

func TestTheDailySwitchTakesEnabledAndNothingElse(t *testing.T) {
	r := newDailyRig(t)
	for name, body := range map[string]string{
		"a schedule":  `{"enabled":true,"cron_expr":"* * * * *"}`,
		"a prompt":    `{"enabled":true,"prompt":"x"}`,
		"a team name": `{"enabled":true,"team_name":"other"}`,
		"a model":     `{"enabled":true,"model":"claude-opus-5-5"}`,
		"no body":     ``,
		"not a bool":  `{"enabled":"yes"}`,
		"missing":     `{}`,
	} {
		code, out := r.call("PUT", dailyBase, body, false)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	jobs, _ := store.NewScheduleStore(r.h.db).ListScheduledJobs(context.Background(), false)
	assert.Empty(t, jobs, "nothing was made")
	code, _ := r.call("PUT", "/api/teams/detail/ghost/daily-knowledge", `{"enabled":true}`, false)
	assert.Equal(t, http.StatusNotFound, code, "a team that does not exist")
}

func TestAnAgentCannotChangeATeamsDailyKnowledge(t *testing.T) {
	r := newDailyRig(t)
	for _, c := range [][3]string{
		{"PUT", dailyBase, `{"enabled":true}`}, {"PUT", dailyBase + "/auto-apply", `{"enabled":true}`},
		{"POST", dailyBase + "/accept", `{"candidate":"x"}`}, {"POST", dailyBase + "/revert", `{"previous":"x"}`},
	} {
		code, out := r.call(c[0], c[1], c[2], true)
		assert.Equal(t, http.StatusForbidden, code, "%s %s: %v", c[0], c[1], out)
		assert.Equal(t, "operator_only", out["code"])
	}
	jobs, _ := store.NewScheduleStore(r.h.db).ListScheduledJobs(context.Background(), false)
	assert.Empty(t, jobs)
	assert.False(t, readFlag(t, r, "auto_apply"))
	// and it can read the status, as it can read the knowledge
	code, _ := r.call("GET", dailyBase, "", true)
	assert.Equal(t, http.StatusOK, code)
}

func readFlag(t *testing.T, r *dailyRig, key string) bool {
	t.Helper()
	_, out := r.call("GET", dailyBase, "", false)
	v, _ := out[key].(bool)
	return v
}

func TestAJobTheSchedulerPausedIsNotSwitchedOnBySwitch(t *testing.T) {
	r := newDailyRig(t)
	_, out := r.call("PUT", dailyBase, `{"enabled":true}`, false)
	id := int64(out["job_id"].(float64))
	_, err := store.NewScheduleStore(r.h.db).UpdateScheduledJob(context.Background(), id, map[string]interface{}{"enabled": 0, "paused_reason": "Paused after 3 failed runs in a row: distilling failed"})
	require.NoError(t, err)
	code, out := r.call("PUT", dailyBase, `{"enabled":true}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "paused_needs_run", out["code"])
	_, st := r.call("GET", dailyBase, "", false)
	assert.Equal(t, false, st["enabled"])
	assert.Contains(t, st["paused_reason"], "Paused after 3 failed runs")
	// off is fine
	code, _ = r.call("PUT", dailyBase, `{"enabled":false}`, false)
	assert.Equal(t, http.StatusOK, code)
}

func TestTheWaitingCandidateShowsItsDiffAndAcceptAndRevertAreAPersonsDecisions(t *testing.T) {
	r := newDailyRig(t)
	team := filepath.Join(r.dir, "agent_knowledge", "alpha")
	require.NoError(t, os.MkdirAll(filepath.Join(team, ".candidate"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(team, "lead.md"), []byte("line one\nold line\nline three\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "lead.md"), []byte("line one\nnew line\nline three\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "dev.md"), []byte("brand new\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "candidate.json"), []byte(`{"created_at":"2026-11-07T03:40:00Z","held":true,"held_reason":"shell-like lines","approx_tokens":900,"agents":["Dev","Lead"]}`), 0o600))
	code, out := r.call("GET", dailyBase, "", false)
	require.Equal(t, http.StatusOK, code)
	cand := out["candidate"].(map[string]any)
	assert.Equal(t, true, cand["held"])
	assert.Equal(t, "shell-like lines", cand["held_reason"])
	files := cand["files"].([]any)
	require.Len(t, files, 2)
	dev, lead := files[0].(map[string]any), files[1].(map[string]any)
	assert.Equal(t, "dev.md", dev["file"])
	assert.Equal(t, true, dev["is_new"])
	assert.Equal(t, "lead.md", lead["file"])
	assert.Contains(t, lead["diff"], "-old line")
	assert.Contains(t, lead["diff"], "+new line")
	cid := cand["id"].(string)
	require.NotEmpty(t, cid)
	// accept is the write, and is a person's
	code, _ = r.call("POST", dailyBase+"/accept", `{"candidate":"`+cid+`","confirm_held":true}`, true)
	require.Equal(t, http.StatusForbidden, code)
	b, _ := os.ReadFile(filepath.Join(team, "lead.md"))
	assert.Contains(t, string(b), "old line", "an agent's accept wrote nothing")
	// it is bound to the candidate that was shown: no id, a wrong id and a stale id write nothing
	for name, body := range map[string]string{"no id": `{}`, "empty id": `{"candidate":""}`, "an extra field": `{"candidate":"` + cid + `","x":1}`} {
		code, _ = r.call("POST", dailyBase+"/accept", body, false)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
	code, out = r.call("POST", dailyBase+"/accept", `{"candidate":"0000000000000000000000aa","confirm_held":true}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "candidate_changed", out["code"])
	// a held candidate needs the person's confirmation
	code, out = r.call("POST", dailyBase+"/accept", `{"candidate":"`+cid+`"}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "held_needs_confirm", out["code"])
	b, _ = os.ReadFile(filepath.Join(team, "lead.md"))
	assert.Contains(t, string(b), "old line", "nothing was written by any of the refusals")
	// a newer run replaces the candidate between the diff and the click: the id the person saw is stale
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "lead.md"), []byte("line one\nnewer still\nline three\n"), 0o600))
	code, out = r.call("POST", dailyBase+"/accept", `{"candidate":"`+cid+`","confirm_held":true}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "candidate_changed", out["code"])
	b, _ = os.ReadFile(filepath.Join(team, "lead.md"))
	assert.Contains(t, string(b), "old line")
	_, out = r.call("GET", dailyBase, "", false)
	cid = out["candidate"].(map[string]any)["id"].(string)
	code, out = r.call("POST", dailyBase+"/accept", `{"candidate":"`+cid+`","confirm_held":true}`, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Nil(t, out["candidate"], "the candidate is gone once accepted")
	b, _ = os.ReadFile(filepath.Join(team, "lead.md"))
	assert.Contains(t, string(b), "newer still")
	code, out = r.call("POST", dailyBase+"/accept", `{"candidate":"`+cid+`","confirm_held":true}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "no_candidate", out["code"])
	// revert is bound to the update that was shown, and takes it back once
	pid := out["previous"]
	_ = pid
	_, st := r.call("GET", dailyBase, "", false)
	prev := st["previous"].(map[string]any)["id"].(string)
	code, out = r.call("POST", dailyBase+"/revert", `{}`, false)
	assert.Equal(t, http.StatusBadRequest, code)
	code, out = r.call("POST", dailyBase+"/revert", `{"previous":"0000000000000000000000bb"}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "candidate_changed", out["code"])
	code, _ = r.call("POST", dailyBase+"/revert", `{"previous":"`+prev+`"}`, true)
	require.Equal(t, http.StatusForbidden, code)
	code, _ = r.call("POST", dailyBase+"/revert", `{"previous":"`+prev+`"}`, false)
	require.Equal(t, http.StatusOK, code)
	b, _ = os.ReadFile(filepath.Join(team, "lead.md"))
	assert.Contains(t, string(b), "old line")
	_, err := os.Stat(filepath.Join(team, "dev.md"))
	assert.True(t, os.IsNotExist(err), "the file the update made is removed again")
	code, out = r.call("POST", dailyBase+"/revert", `{"previous":"`+prev+`"}`, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "nothing_to_revert", out["code"])
}

func TestTheApplyAutomaticallySwitchIsOffByDefaultAndIsAPersonsToChange(t *testing.T) {
	r := newDailyRig(t)
	assert.False(t, readFlag(t, r, "auto_apply"))
	code, _ := r.call("PUT", dailyBase+"/auto-apply", `{"enabled":true,"x":1}`, false)
	assert.Equal(t, http.StatusBadRequest, code)
	code, out := r.call("PUT", dailyBase+"/auto-apply", `{"enabled":true}`, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["auto_apply"])
	code, out = r.call("PUT", dailyBase+"/auto-apply", `{"enabled":false}`, false)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["auto_apply"])
}

// A person's save of an agent's knowledge file is marked, so a daily run leaves that file alone.
func TestAPersonsSaveOfAnAgentsKnowledgeIsMarkedForTheDailyRun(t *testing.T) {
	r := newDailyRig(t)
	team := filepath.Join(r.dir, "agent_knowledge", "alpha")
	require.NoError(t, os.MkdirAll(team, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(team, "index.md"), []byte("index"), 0o600))
	rt := chi.NewRouter()
	rt.Put("/api/teams/detail/{name}/knowledge/{agentName}", r.h.SaveAgentKnowledge)
	req := httptest.NewRequest("PUT", "/api/teams/detail/alpha/knowledge/Lead", strings.NewReader(`{"content":"my own words"}`))
	w := httptest.NewRecorder()
	rt.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	b, err := os.ReadFile(filepath.Join(team, ".edited.json"))
	require.NoError(t, err)
	assert.Contains(t, string(b), `"lead"`)
}

// Security's SHOULD on #13928: the waiting candidate and its diff are unreviewed transcript text, the owner's to read. A Hub viewer or grantee and an agent get the switch state and the last run, with no candidate body.
func (r *dailyRig) get(hdr map[string]string) (int, map[string]any) {
	r.t.Helper()
	req, _ := http.NewRequest("GET", r.srv.URL+dailyBase, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestOnlyTheOwnerReadsTheWaitingCandidateAndItsDiff(t *testing.T) {
	r := newDailyRig(t)
	withLabel(t, cmtHubUser, nil)
	team := filepath.Join(r.dir, "agent_knowledge", "alpha")
	require.NoError(t, os.MkdirAll(filepath.Join(team, ".candidate"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(team, "lead.md"), []byte("line one\nold line\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "lead.md"), []byte("line one\nSECRET-ISH new line from a transcript\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(team, ".candidate", "candidate.json"), []byte(`{"created_at":"2026-11-07T03:40:00Z","held":true,"held_reason":"shell-like lines","approx_tokens":900,"agents":["lead"]}`), 0o600))
	// the Operator at this computer, and the Hub's owner: the candidate and its diff
	for name, hdr := range map[string]map[string]string{"the Operator": cmtAsOwner, "the Hub's owner": cmtAsHubOwner} {
		code, out := r.get(hdr)
		require.Equal(t, http.StatusOK, code, name)
		cand, ok := out["candidate"].(map[string]any)
		require.True(t, ok, "%s sees the candidate: %v", name, out)
		raw, _ := json.Marshal(cand)
		assert.Contains(t, string(raw), "SECRET-ISH new line", name)
		assert.NotContains(t, out, "candidate_waiting", name)
	}
	// a Hub viewer or grantee, and an agent: the switch and the last run, and that one waits, with no body, diff, id or reason
	for name, hdr := range map[string]map[string]string{"a Hub viewer": cmtAsHub, "a Hub viewer with the Operator's credential": cmtAsOwnerThroughTunnel, "an agent": {testAgentHeader: "dddddddd-0001"}} {
		code, out := r.get(hdr)
		require.Equal(t, http.StatusOK, code, name)
		assert.Contains(t, out, "enabled", name)
		assert.Equal(t, true, out["candidate_waiting"], name)
		assert.NotContains(t, out, "candidate", name)
		raw, _ := json.Marshal(out)
		for _, leak := range []string{"SECRET-ISH", "shell-like lines", "old line", "@@"} {
			assert.NotContains(t, string(raw), leak, "%s: %s", name, leak)
		}
	}
}
