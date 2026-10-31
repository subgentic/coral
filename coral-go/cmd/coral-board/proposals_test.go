package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11389: with a team's goals or tasks needing the Operator's approval, the server answers 202 with a message; coral-board prints it and succeeds (nothing was created yet), and task add can say which waiting goal the task is for.
func TestCLIPrintsTheWaitingMessageOfAProposal(t *testing.T) {
	var taskBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/goals") && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"pending":true,"proposal_id":7,"message":"waiting for the Operator's approval (#7): this team's goals need it before they are made"}`)
		case strings.HasSuffix(r.URL.Path, "/tasks") && r.Method == http.MethodPost:
			buf := make([]byte, 4096)
			n, _ := r.Body.Read(buf)
			taskBody = string(buf[:n])
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"pending":true,"proposal_id":8,"message":"waiting for the Operator's approval (#8): this team's tasks need it before they are made"}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	}))
	t.Cleanup(srv.Close)
	dir := subscribedDataDir(t, srv.URL)

	run := runBoard(t, srv.URL, dir, "goal", "add", "Ship the beta")
	assert.Equal(t, 0, run.code, run.stderr)
	assert.Contains(t, run.stdout, "Goal proposed: waiting for the Operator's approval (#7)")
	assert.NotContains(t, run.stdout, "Created Goal")

	run = runBoard(t, srv.URL, dir, "task", "add", "Do the thing", "--goal-proposal", "7")
	assert.Equal(t, 0, run.code, run.stderr)
	assert.Contains(t, run.stdout, "Task proposed: waiting for the Operator's approval (#8)")
	assert.NotContains(t, run.stdout, "Created Task")
	assert.Contains(t, taskBody, `"goal_proposal_id":7`)
}
