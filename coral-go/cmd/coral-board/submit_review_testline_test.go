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
		"Command exited with code 1", "exited with code 0", "exit code 1", // #587: a model sent exited with code 1 and was refused
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
	if err == nil || !strings.Contains(out, noTestResultText("candidate 1")) || calls != 0 {
		t.Fatalf("a note with no test line must exit 1 before any request, saying the message was read: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run(); err == nil || !strings.Contains(out, noTestResultText("")) || calls != 0 {
		t.Fatalf("no --message at all is refused with the plain ask: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run("--message", noTestResultText("candidate 1")); err == nil || calls != 0 {
		t.Fatalf("the refusal pasted into --message is not a test result: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run("--message", "Command exited with code 1"); err != nil || calls != 1 {
		t.Fatalf("an exit line goes through (#587): err=%v calls=%d out=%q", err, calls, out)
	}
	calls = 0
	if out, err = run("--message", "go test: ok  github.com/subgentic/coral/cmd/coral-board 0.6s"); err != nil || calls != 1 {
		t.Fatalf("a pasted result goes through: err=%v calls=%d out=%q", err, calls, out)
	}
	if out, err = run("--message", "README only", "--no-tests", "docs only"); err != nil || calls != 2 {
		t.Fatalf("--no-tests lets a docs-only change through: err=%v calls=%d out=%q", err, calls, out)
	}
}

// #587 (eval Pass B, t06): a model pasted the old refusal's quoted example into --message, the shell broke on the quotes, and it then
// looped on the same refusal. The refusal holds no quotes, says when --message was read and did not count, shows what counts, keeps
// --no-tests in sight, and is not itself a test result.
func TestNoTestResultTextIsSafeToPasteAndSaysWhatCounts(t *testing.T) {
	empty, read := noTestResultText(""), noTestResultText("candidate 1")
	if empty == read {
		t.Fatalf("an empty note and a note that was read get the same refusal: %q", empty)
	}
	if !strings.Contains(read, "--message was read") || !strings.Contains(read, "does not count") {
		t.Errorf("a note that was given is said to be read and not to count: %q", read)
	}
	for _, text := range []string{empty, read} {
		if strings.ContainsAny(text, "\"'`<>$") {
			t.Errorf("the refusal holds a quote or shell character, which breaks a command it is pasted into: %q", text)
		}
		for _, want := range []string{"--message", "N passed, M failed", "exit code N", "--no-tests"} {
			if !strings.Contains(text, want) {
				t.Errorf("the refusal does not say %q: %q", want, text)
			}
		}
		if hasTestResult(text) {
			t.Errorf("the refusal reads as a test result, so pasting it would pass the check: %q", text)
		}
	}
	for _, ex := range []string{"12 passed, 0 failed", "exit code 0"} { // the example's shape with real numbers is what counts
		if !hasTestResult(ex) {
			t.Errorf("the example's shape with numbers, %q, is not taken", ex)
		}
	}
}
