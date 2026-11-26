package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// #21481: the mock's two commands, "worker launch NAME --task N --worktree" and "worker archive NAME|#N --remove-worktree", call the launch and the archive routes with the flags the server reads.
type workerRecorder struct {
	*httptest.Server
	mu   sync.Mutex
	reqs []string
}

func (w *workerRecorder) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.reqs...)
}

func newWorkerRecorder(t *testing.T) *workerRecorder {
	rec := &workerRecorder{}
	rec.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.reqs = append(rec.reqs, r.Method+" "+r.URL.Path+" "+strings.TrimSpace(string(b)))
		rec.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			w.Write([]byte(`{"status":"ok","version":"test"}`))
		case strings.HasSuffix(r.URL.Path, "/launch"):
			w.Write([]byte(`{"display_name":"Dev #12","session_name":"claude-x","worktree":{"name":"task-12"}}`))
		case strings.HasSuffix(r.URL.Path, "/workers"):
			w.Write([]byte(`{"workers":[{"name":"Dev"}],"launched":{"Dev #12":"Dev"}}`))
		case strings.HasSuffix(r.URL.Path, "/tasks/13"):
			w.Write([]byte(`{"id":13,"title":"t","status":"in_progress","assigned_to":"Frontend Dev"}`))
		case strings.Contains(r.URL.Path, "/tasks/"):
			w.Write([]byte(`{"id":12,"title":"t","status":"in_progress","assigned_to":"Dev #12"}`))
		case strings.HasSuffix(r.URL.Path, "/stop"):
			w.Write([]byte(`{"stopped":true,"name":"Dev #12","worktree":{"state":"removed","name":"task-12"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(rec.Close)
	return rec
}

func workerCLIServer(t *testing.T) *workerRecorder {
	rec := newWorkerRecorder(t)
	serverURL = rec.URL
	return rec
}

func runWorker(t *testing.T, args ...string) string {
	before := os.Args
	defer func() { os.Args = before }()
	os.Args = append([]string{"coral-board", "worker"}, args...)
	return captureStdout(t, cmdWorker)
}

func TestWorkerLaunchWorktreeSendsTheFlagAndSaysHowToArchive(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "orch")
	saveState(&boardState{Project: "crew", JobTitle: "Orchestrator"})
	rec := workerCLIServer(t)

	out := runWorker(t, "launch", "Dev", "--task", "12", "--worktree")
	if len(rec.snapshot()) != 1 || !strings.Contains((rec.snapshot())[0], `/board/crew/workers/Dev/launch`) || !strings.Contains((rec.snapshot())[0], `"task_id":12`) || !strings.Contains((rec.snapshot())[0], `"worktree":true`) {
		t.Fatalf("requests: %v", rec.snapshot())
	}
	for _, want := range []string{"Launched Dev #12", "Own worktree: task-12", `coral-board worker archive "Dev #12" --remove-worktree`} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q misses %q", out, want)
		}
	}
	rec.mu.Lock()
	rec.reqs = nil
	rec.mu.Unlock()
	runWorker(t, "launch", "Dev", "--task", "12")
	if strings.Contains((rec.snapshot())[0], "worktree") {
		t.Fatalf("without the flag no worktree is asked for: %v", rec.snapshot())
	}
}

func TestWorkerArchiveCallsTheStopRouteForANameOrATaskNumber(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "orch")
	saveState(&boardState{Project: "crew", JobTitle: "Orchestrator"})
	rec := workerCLIServer(t)

	out := runWorker(t, "archive", "Dev #12", "--remove-worktree")
	if len(rec.snapshot()) != 1 || !strings.Contains((rec.snapshot())[0], "POST /api/board/crew/agents/Dev%20%2312/stop") && !strings.Contains((rec.snapshot())[0], "/agents/Dev #12/stop") || !strings.Contains((rec.snapshot())[0], `"remove_worktree":true`) {
		t.Fatalf("requests: %v", rec.snapshot())
	}
	if !strings.Contains(out, "Stopped Dev #12") || !strings.Contains(out, "Its worktree task-12 was removed. The branch is kept.") {
		t.Fatalf("output: %q", out)
	}

	rec.mu.Lock()
	rec.reqs = nil
	rec.mu.Unlock()
	runWorker(t, "archive", "#12")
	if len(rec.snapshot()) != 3 || !strings.Contains((rec.snapshot())[0], "GET /api/board/crew/tasks/12") || !strings.Contains((rec.snapshot())[1], "GET /api/board/crew/workers") || !strings.Contains((rec.snapshot())[2], "/stop") || strings.Contains((rec.snapshot())[2], "remove_worktree") {
		t.Fatalf("#N reads the task's assignee, then archives it; without the flag no removal is asked for: %v", rec.snapshot())
	}
}

// A wrong #N must not stop a teammate: task 13 is assigned to a regular agent, which no worker launch started and no approved worker is called, so the command refuses and nothing is stopped.
func TestWorkerArchiveByTaskNumberRefusesANonWorker(t *testing.T) {
	dataDir := isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "orch")
	saveState(&boardState{Project: "crew", JobTitle: "Orchestrator"})
	rs := newWorkerRecorder(t)
	r := runBoardEnv(t, rs.URL, dataDir, []string{"CORAL_SESSION_NAME=coral-board-test-session"}, "worker", "archive", "#13", "--remove-worktree")
	if r.code == 0 || !strings.Contains(r.stderr, "Task #13 is assigned to Frontend Dev") || !strings.Contains(r.stderr, "was not stopped") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	for _, q := range rs.snapshot() {
		if strings.Contains(q, "/stop") {
			t.Fatalf("nothing is stopped, but the command called %s", q)
		}
	}
}
