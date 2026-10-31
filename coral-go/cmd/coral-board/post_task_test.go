package main

import (
	"bytes"
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// post --task N answers a task (#7703): the body carries task_id, the number is checked, and a read says how to answer a reply on a task.
func TestPostTaskSendsTheTaskId(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--task", "42", "Done by tonight.")
	require.Equal(t, 0, res.code, res.stderr)
	reqs := srv.requests()
	require.Len(t, reqs, 1)
	assert.Contains(t, reqs[0], `"task_id":42`)
	assert.Contains(t, reqs[0], `"content":"Done by tonight."`)

	srv2 := newRecordingServer(t)
	dir2 := subscribedDataDir(t, srv2.URL)
	for _, args := range [][]string{{"post", "--task", "x", "hi"}, {"post", "--task", "0", "hi"}, {"post", "--task"}} {
		res := runBoard(t, srv2.URL, dir2, args...)
		assert.Equal(t, 2, res.code, "%v: %q", args, res.stderr)
	}
	assert.Empty(t, srv2.requests(), "a bad task number sends nothing")

	srv3 := newRecordingServer(t)
	dir3 := subscribedDataDir(t, srv3.URL)
	require.Equal(t, 0, runBoard(t, srv3.URL, dir3, "post", "--broadcast", "plain").code)
	assert.NotContains(t, srv3.requests()[0], "task_id", "a plain post has no task")
}

func TestReadTellsHowToAnswerAReplyOnATask(t *testing.T) {
	out := captureStdout(t, func() {
		printMessages([]map[string]any{
			{"created_at": "2026-10-25T10:00:00Z", "subscriber_id": "Operator", "content": "@Backend Dev: how far along?", "task_id": 42.0},
			{"created_at": "2026-10-25T10:01:00Z", "subscriber_id": "Lead", "content": "a plain message"},
		})
	})
	assert.Contains(t, out, `(a reply on task #42: answer it on the task with  coral-board post --task 42 "...")`)
	assert.Equal(t, 1, bytes.Count([]byte(out), []byte("a reply on task")), "only the message with a task says it")
}

// captureStdout returns what fn printed to os.Stdout.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	require.NoError(t, w.Close())
	b, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(b)
}
