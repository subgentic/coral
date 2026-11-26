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
func workerCLIServer(t *testing.T) (*[]string, func()) {
	var mu sync.Mutex
	var reqs []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, r.Method+" "+r.URL.Path+" "+strings.TrimSpace(string(b)))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/launch"):
			w.Write([]byte(`{"display_name":"Dev #12","session_name":"claude-x","worktree":{"name":"task-12"}}`))
		case strings.Contains(r.URL.Path, "/tasks/"):
			w.Write([]byte(`{"id":12,"title":"t","status":"in_progress","assigned_to":"Dev #12"}`))
		case strings.HasSuffix(r.URL.Path, "/stop"):
			w.Write([]byte(`{"stopped":true,"name":"Dev #12","worktree":{"state":"removed","name":"task-12"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	serverURL = server.URL
	return &reqs, server.Close
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
	reqs, closeFn := workerCLIServer(t)
	defer closeFn()

	out := runWorker(t, "launch", "Dev", "--task", "12", "--worktree")
	if len(*reqs) != 1 || !strings.Contains((*reqs)[0], `/board/crew/workers/Dev/launch`) || !strings.Contains((*reqs)[0], `"task_id":12`) || !strings.Contains((*reqs)[0], `"worktree":true`) {
		t.Fatalf("requests: %v", *reqs)
	}
	for _, want := range []string{"Launched Dev #12", "Own worktree: task-12", `coral-board worker archive "Dev #12" --remove-worktree`} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q misses %q", out, want)
		}
	}
	*reqs = nil
	runWorker(t, "launch", "Dev", "--task", "12")
	if strings.Contains((*reqs)[0], "worktree") {
		t.Fatalf("without the flag no worktree is asked for: %v", *reqs)
	}
}

func TestWorkerArchiveCallsTheStopRouteForANameOrATaskNumber(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "orch")
	saveState(&boardState{Project: "crew", JobTitle: "Orchestrator"})
	reqs, closeFn := workerCLIServer(t)
	defer closeFn()

	out := runWorker(t, "archive", "Dev #12", "--remove-worktree")
	if len(*reqs) != 1 || !strings.Contains((*reqs)[0], "POST /api/board/crew/agents/Dev%20%2312/stop") && !strings.Contains((*reqs)[0], "/agents/Dev #12/stop") || !strings.Contains((*reqs)[0], `"remove_worktree":true`) {
		t.Fatalf("requests: %v", *reqs)
	}
	if !strings.Contains(out, "Stopped Dev #12") || !strings.Contains(out, "Its worktree task-12 was removed. The branch is kept.") {
		t.Fatalf("output: %q", out)
	}

	*reqs = nil
	runWorker(t, "archive", "#12")
	if len(*reqs) != 2 || !strings.Contains((*reqs)[0], "GET /api/board/crew/tasks/12") || !strings.Contains((*reqs)[1], "/stop") || strings.Contains((*reqs)[1], "remove_worktree") {
		t.Fatalf("#N reads the task's assignee, then archives it; without the flag no removal is asked for: %v", *reqs)
	}
}
