package main

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestTaskEditHistoryAndVersionRead(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "creator")
	saveState(&boardState{Project: "team", JobTitle: "creator"})
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "PATCH" {
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			require.Equal(t, "creator", body["subscriber_id"])
			require.Equal(t, "New title", body["title"])
			require.Equal(t, "high", body["priority"])
			w.Write([]byte(`{"version":2,"title":"New title"}`))
			return
		}
		w.Write([]byte(`{"id":7,"version":1,"snapshot":{"title":"Before"}}`))
	}))
	defer server.Close()
	serverURL = server.URL
	run := func(args ...string) {
		old := os.Args
		defer func() { os.Args = old }()
		os.Args = append([]string{"coral-board", "task"}, args...)
		cmdTask()
	}
	run("edit", "7", "--title", "New title", "--priority", "high")
	run("history", "7")
	run("detail", "7", "--version", "1")
	require.Equal(t, 1, loadSeenRounds()["team/7#task-version"], "reading a historical version records the older text, not the latest version")
	require.Equal(t, []string{"PATCH /api/board/team/tasks/7", "GET /api/board/team/tasks/7/history", "GET /api/board/team/tasks/7?version=1"}, calls)
}
