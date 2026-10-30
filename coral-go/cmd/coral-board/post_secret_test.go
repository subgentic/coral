package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A message carrying a sign-in link's token is refused, not redacted: from the arguments, --file or stdin, in any
// case and URL-encoded. Nothing reaches the server, and the error says why and what to post instead. A message
// that only talks about sign-in links goes through.
func TestPostAndSendRefuseASignInLink(t *testing.T) {
	const link = "http://127.0.0.1:8471/?login_token=abc123def"
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	file := filepath.Join(t.TempDir(), "result.txt")
	require.NoError(t, os.WriteFile(file, []byte("Opened the link:\n"+link+"\n"), 0o600))

	for name, run := range map[string]func() boardRun{
		"post, an argument": func() boardRun { return runBoard(t, srv.URL, dir, "post", "result: "+link) },
		"post, upper case":  func() boardRun { return runBoard(t, srv.URL, dir, "post", "LOGIN_TOKEN=abc123") },
		"post, URL-encoded": func() boardRun { return runBoard(t, srv.URL, dir, "post", "next=%2F%3Flogin_token%3Dabc123") },
		"post --file":       func() boardRun { return runBoard(t, srv.URL, dir, "post", "--file", file) },
		"post - (stdin)": func() boardRun {
			return runBoardInput(t, srv.URL, dir, strings.NewReader("output:\n"+link+"\n"), "post", "-")
		},
		"post --assign":          func() boardRun { return runBoard(t, srv.URL, dir, "post", "--assign", "Dev A", "@Dev A try "+link) },
		"send --board, argument": func() boardRun { return runBoard(t, srv.URL, dir, "send", "--board", "other", link) },
		"send --file":            func() boardRun { return runBoard(t, srv.URL, dir, "send", "--board", "other", "--file", file) },
	} {
		res := run()
		assert.NotEqual(t, 0, res.code, "%s: refused", name)
		assert.Contains(t, res.stderr, "refusing a message that contains a sign-in link (login_token=)", name)
		assert.Contains(t, res.stderr, "Nothing was sent. Post only the result lines", name)
		assert.NotContains(t, res.stderr, "abc123", "%s: the error never repeats the token", name)
	}
	assert.Empty(t, srv.requests(), "a refused message sends nothing")

	res := runBoard(t, srv.URL, dir, "post", "the login token test passed: 300/300, no link in this post")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.requests(), 1, "a message about sign-in links, with no token in it, is posted")
}

// Every other text members read goes through the same check on the request body: task and goal text, titles,
// notes, reasons, reviews, requests. None of it reaches the server (a command may still read first).
func TestEveryTextMembersReadRefusesASignInLink(t *testing.T) {
	const tok = "login_token=abc123def"
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	for name, args := range map[string][]string{
		"task add, the title":          {"task", "add", "check " + tok},
		"task add --body":              {"task", "add", "a title", "--body", "see " + tok},
		"task edit --title":            {"task", "edit", "7", "--title", tok},
		"task submit-review --message": {"task", "submit-review", "7", "--reason", "review pending", "--message", tok},
		"task complete --message":      {"task", "complete", "7", "--message", tok},
		"goal add, the title":          {"goal", "add", "goal " + tok},
		"goal add --outcome":           {"goal", "add", "a goal", "--outcome", tok},
		"goal add --done-when":         {"goal", "add", "a goal", "--done-when", tok},
		"goal update --title":          {"goal", "update", "3", "--title", tok},
		"goal close --reason":          {"goal", "close", "3", "--reason", tok},
		"goal request --ask":           {"goal", "request", "3", "--to", "other", "--ask", tok},
		"post --assign --title":        {"post", "--assign", "Dev A", "--goal", "1", "--title", tok, "a plain body"},
	} {
		res := runBoard(t, srv.URL, dir, args...)
		assert.NotEqual(t, 0, res.code, "%s: refused (%s)", name, res.stderr)
		assert.Contains(t, res.stderr, "that contains a sign-in link (login_token=)", name)
		assert.Contains(t, res.stderr, "To talk about the parameter, write it without '='.", name)
		assert.NotContains(t, res.stderr, "abc123", "%s: the error never repeats the token", name)
	}
	for _, req := range srv.requests() {
		assert.NotContains(t, req, "abc123", "no request carries the token: %s", req)
	}
}
