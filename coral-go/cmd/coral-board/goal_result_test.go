package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21811: `goal close` sends the finished result to Needs you, or says why there is none; with neither it refuses and closes nothing.
func TestGoalCloseRefusesWithNeitherResultNorNoResult(t *testing.T) {
	gs := newGoalServer(t)
	res := goalRun(t, gs, "goal", "close", "3", "--reason", "shipped")
	assert.Equal(t, 1, res.code)
	assert.Contains(t, res.stderr, "--result")
	assert.Contains(t, res.stderr, "--no-result")
	assert.Contains(t, res.stderr, "Nothing was closed")
	assert.Empty(t, gs.requests(), "no request at all")

	res = goalRun(t, gs, "goal", "close", "3", "--reason", "shipped", "--result", "x.md", "--no-result", "none")
	assert.Equal(t, 1, res.code)
	assert.Contains(t, res.stderr, "not both")
	assert.Empty(t, gs.requests())
}

func TestGoalCloseWithAResultFileUploadsItAsTheGoalsFinishedResultThenCloses(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery+" "+r.Header.Get("X-Artifact-Task")+" "+string(body))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/agent/artifacts":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"uri":"coral://artifacts/` + strings.Repeat("ab", 32) + `","for_review":true}`))
		case strings.HasSuffix(r.URL.Path, "/close"):
			_, _ = w.Write([]byte(`{"goal":{"id":5,"state":"done"},"open_tasks":0}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	file := filepath.Join(t.TempDir(), "result.md")
	require.NoError(t, os.WriteFile(file, []byte("# the result"), 0o600))
	res := runBoardEnv(t, srv.URL, agentDataDir(t, srv.URL), []string{"CORAL_SESSION_NAME=" + agentSession}, "goal", "close", "5", "--reason", "fine-tune shipped", "--result", file)
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Sent the result to the Operator's Needs you: coral://artifacts/"+strings.Repeat("ab", 32))
	assert.Contains(t, res.stdout, "Closed Goal #5")
	mu.Lock()
	defer mu.Unlock()
	var upload, closeReq string
	for _, s := range seen {
		if strings.HasPrefix(s, "POST /api/agent/artifacts?") {
			upload = s
		}
		if strings.Contains(s, "/close?") {
			closeReq = s
		}
	}
	require.NotEmpty(t, upload, seen)
	assert.Contains(t, upload, "kind=done")
	assert.Contains(t, upload, "goal=5")
	assert.Contains(t, upload, "tag=for+review")
	assert.Contains(t, upload, " none # the result", "the result is the goal's, linked to no task")
	require.NotEmpty(t, closeReq, seen)
	assert.Contains(t, closeReq, `"result":"coral://artifacts/`+strings.Repeat("ab", 32)+`"`)
}

func TestGoalCloseDoesNotCloseWhenTheResultCannotBeSent(t *testing.T) {
	gs := newGoalServer(t)
	res := runBoardEnv(t, gs.URL, agentDataDir(t, gs.URL), []string{"CORAL_SESSION_NAME=" + agentSession}, "goal", "close", "5", "--reason", "shipped", "--result", filepath.Join(t.TempDir(), "missing.md"))
	assert.Equal(t, 1, res.code)
	assert.Contains(t, res.stderr, "neither a file nor a coral://artifacts")
	assert.Contains(t, res.stderr, "not closed")
	for _, r := range gs.requests() {
		assert.NotContains(t, r, "/close", "no close request")
	}
}

const agentSession = "claude-816cced9-f065-2b4a-823f-b2df4a3acd53"

// agentDataDir is subscribedDataDir for an agent session that has a Coral session id in its name.
func agentDataDir(t *testing.T, serverURL string) string {
	t.Helper()
	dir := t.TempDir()
	state, _ := json.Marshal(boardState{Project: "team", JobTitle: "Tester", ServerURL: serverURL})
	require.NoError(t, os.WriteFile(filepath.Join(dir, "board_state_"+agentSession+".json"), state, 0o644))
	return dir
}
