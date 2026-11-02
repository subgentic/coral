package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12164 (the Operator: "attach the goal and task the question is about"): post --ask takes --goal N and --task N: what the question is about, sent as ask_goal and ask_task (the server checks them against the team). On a
// question --task is not an answer on a task (it would notify the task's people); without --ask the options keep their old meaning and --goal stays for --assign.
func TestPostAskTakesTheGoalAndTaskItIsAbout(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--ask", "--goal", "7", "--task", "42", "@Operator ship the first slice now?")
	require.Equal(t, 0, res.code, res.stderr)
	res = runBoard(t, srv.URL, dir, "post", "--ask", "--task", "42", "@Operator only the task?")
	require.Equal(t, 0, res.code, res.stderr)
	res = runBoard(t, srv.URL, dir, "post", "--ask", "@Operator neither?")
	require.Equal(t, 0, res.code, res.stderr)
	reqs := srv.requests()
	require.Len(t, reqs, 3)
	assert.Contains(t, reqs[0], `"ask":true`)
	assert.Contains(t, reqs[0], `"ask_goal":7`)
	assert.Contains(t, reqs[0], `"ask_task":42`)
	assert.NotContains(t, reqs[0], `"task_id"`, "on a question --task is its subject, not an answer on a task")
	assert.Contains(t, reqs[1], `"ask_task":42`)
	assert.NotContains(t, reqs[1], "ask_goal")
	assert.NotContains(t, reqs[2], "ask_goal")
	assert.NotContains(t, reqs[2], "ask_task")

	// not a question: --task is an answer on a task as before, --goal is for --assign
	res = runBoard(t, srv.URL, dir, "post", "--task", "42", "@Dev A done")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, srv.requests()[3], `"task_id":42`)
	assert.NotContains(t, srv.requests()[3], "ask_task")

	srv2 := newRecordingServer(t)
	dir2 := subscribedDataDir(t, srv2.URL)
	for name, args := range map[string][]string{
		"a goal that is no number":      {"post", "--ask", "--goal", "x", "@Operator hi"},
		"goal 0":                        {"post", "--ask", "--goal", "0", "@Operator hi"},
		"a negative task":               {"post", "--ask", "--task", "-3", "@Operator hi"},
		"a task that is no number":      {"post", "--ask", "--task", "x", "@Operator hi"},
		"a goal on a plain post":        {"post", "--goal", "7", "@Dev A hi"},
		"goal on a question to a guide": {"post", "--ask", "--guide", "hub-x", "--goal", "7", "hi"},
	} {
		res := runBoard(t, srv2.URL, dir2, args...)
		assert.Equal(t, 2, res.code, "%s: %q", name, res.stderr)
	}
	assert.Empty(t, srv2.requests(), "a bad option sends nothing")
}
