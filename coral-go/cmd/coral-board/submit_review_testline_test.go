package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/subgentic/coral/internal/testguard"
)

// #18292: submit-review asks for the pasted last line of the test run.

func TestHasTestResultReadsTheLinesPeoplePaste(t *testing.T) {
	for _, ok := range []string{
		"test:cloud EXIT=0", "ok  \tgithub.com/subgentic/coral/internal/background\t0.8s", "1/1 suites passed in 1.2s",
		"12 passed, 0 failed", "FAIL\tgithub.com/x/y", "--- PASS: TestX", "go test exit 0", "all passed",
	} {
		if !hasTestResult(ok) {
			t.Errorf("%q is a test result", ok)
		}
	}
	for _, no := range []string{"", "ready for review", "Patch ready: the Goals view, layout A.", "I ran the tests and they are fine", "candidate 1"} {
		if hasTestResult(no) {
			t.Errorf("%q has no test result line", no)
		}
	}
}

func TestSubmitReviewWithoutATestLineIsRefusedUnlessNoTestsSaysWhy(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "worker")
	saveState(&boardState{Project: "pool", JobTitle: "Developer"})
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":42,"status":"review_pending"}`))
	}))
	defer server.Close()
	run := func(extra ...string) (string, error) {
		enc, _ := json.Marshal(append([]string{"task", "submit-review", "42", "--reason", "ready", "--head", "abc1234def5678"}, extra...))
		cmd := exec.CommandContext(helperCtx(t), os.Args[0], "-test.run=^TestBoardPathHelperProcess$")
		cmd.Env = append(os.Environ(), "CORAL_BOARD_HELPER_ARGS="+string(enc), "CORAL_URL="+server.URL, testguard.TestURLEnv+"=1")
		cmd.Stdin = strings.NewReader("")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	out, err := run("--message", "candidate 1")
	if err == nil || !strings.Contains(out, "paste the last line of the test run") || calls != 0 {
		t.Fatalf("a note with no test line must exit 1 before any request: err=%v calls=%d out=%q", err, calls, out)
	}
	if !strings.Contains(out, "into the note with --message, e.g. coral-board task submit-review 42 --reason") || !strings.Contains(out, "--no-tests") {
		t.Fatalf("the refusal names the flag and gives an example with this task's number: %q", out)
	}
	if out, err = run("--message", "<the last line of your test run>"); err == nil || calls != 0 {
		t.Fatalf("the example's placeholder copied as it is is not a test result: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run("--message", "go test: ok  github.com/subgentic/coral/cmd/coral-board 0.6s"); err != nil || calls != 1 {
		t.Fatalf("a pasted result goes through: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run("--message", "README only", "--no-tests", "docs only"); err != nil || calls != 2 {
		t.Fatalf("--no-tests lets a docs-only change through: err=%v calls=%d out=%q", err, calls, out)
	}
}
