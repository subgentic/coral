package background

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/store"
)

func runQuietWorkflow(t *testing.T, steps []StepDef) (*store.WorkflowStore, *store.WorkflowRun, []StepResult) {
	t.Helper()
	db := setupTestDB(t)
	wfStore := store.NewWorkflowStore(db)
	rt := newWfMockRuntime()
	runner := NewWorkflowRunner(wfStore, &AgentLauncher{runtime: rt}, rt, nil, nil, t.TempDir(), "localhost", 8420)
	stepsJSON, _ := json.Marshal(steps)
	wf := createTestWorkflow(t, wfStore, t.TempDir(), string(stepsJSON))
	run, err := runner.TriggerWorkflow(context.Background(), wf, "api", nil)
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	waitForRun(t, wfStore, run.ID, 10*time.Second)
	final, _ := wfStore.GetWorkflowRunDirect(context.Background(), run.ID)
	var results []StepResult
	_ = json.Unmarshal([]byte(final.StepResults), &results)
	return wfStore, final, results
}

// A shell step that exits 78 ends the run as quiet: the step is done, the steps after it are skipped and never start, the run is no failure, and no one is asked to open it.
func TestShellStepExit78EndsTheRunQuietly(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran")
	_, run, results := runQuietWorkflow(t, []StepDef{
		{Name: "check", Type: "shell", Command: "echo nothing fired; exit 78"},
		{Name: "act", Type: "shell", Command: "touch " + marker},
		{Name: "agent", Type: "agent", Prompt: "should never start"},
	})
	if run.Status != store.RunQuiet {
		t.Fatalf("status = %q, want quiet", run.Status)
	}
	if run.ErrorMsg != nil || run.ErrorCode != nil {
		t.Errorf("a quiet run carries no error: %v %v", run.ErrorMsg, run.ErrorCode)
	}
	if run.FinishedAt == nil || run.SeenAt == nil {
		t.Errorf("a quiet run is finished and already seen: finished=%v seen=%v", run.FinishedAt, run.SeenAt)
	}
	if len(results) != 3 || results[0].Status != "completed" || results[1].Status != "skipped" || results[2].Status != "skipped" {
		t.Fatalf("results = %+v", results)
	}
	if results[0].Note == "" || results[0].ExitCode == nil || *results[0].ExitCode != 78 {
		t.Errorf("the quiet step says so: note=%q exit=%v", results[0].Note, results[0].ExitCode)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a step after the quiet one ran")
	}
}

// Every other end stays what it was: exit 1 fails the run, exit 77 and 79 (the neighbours) fail it, a step that is killed by its timeout never reads as quiet, and continue_on_failure does not turn 78 into a failure to go on from.
func TestOnlyExit78IsQuietAndAFailureIsNeverHiddenByIt(t *testing.T) {
	for _, code := range []string{"1", "77", "79", "255"} {
		_, run, results := runQuietWorkflow(t, []StepDef{{Name: "check", Type: "shell", Command: "exit " + code}, {Name: "after", Type: "shell", Command: "true"}})
		if run.Status != "failed" || results[0].Status != "failed" || results[1].Status != "skipped" {
			t.Errorf("exit %s: run %q steps %+v, want a failed run", code, run.Status, results)
		}
	}
	_, run, results := runQuietWorkflow(t, []StepDef{{Name: "slow", Type: "shell", Command: "sleep 5; exit 78", TimeoutS: 1}, {Name: "after", Type: "shell", Command: "true"}})
	if run.Status == store.RunQuiet || results[0].Status != "failed" {
		t.Errorf("a timeout is a failure, not quiet: run %q step %+v", run.Status, results[0])
	}
	// the quiet step wins over continue_on_failure: the run is quiet and the next step does not run
	_, run, results = runQuietWorkflow(t, []StepDef{{Name: "check", Type: "shell", Command: "exit 78", ContinueOnFailure: true}, {Name: "after", Type: "shell", Command: "true"}})
	if run.Status != store.RunQuiet || results[1].Status != "skipped" {
		t.Errorf("with continue_on_failure: run %q steps %+v", run.Status, results)
	}
}
