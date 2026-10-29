package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
)

// The parameter refused is the sign-in link's own (coral-board doesn't link the auth package).
func TestTheRefusedParamIsTheSignInLinksOwn(t *testing.T) {
	assert.Equal(t, auth.LoginTokenParam, loginTokenParam)
}

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
		assert.Contains(t, res.stderr, "Nothing was posted. Post only the result lines", name)
		assert.NotContains(t, res.stderr, "abc123", "%s: the error never repeats the token", name)
	}
	assert.Empty(t, srv.requests(), "a refused message sends nothing")

	res := runBoard(t, srv.URL, dir, "post", "the login token test passed: 300/300, no link in this post")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.requests(), 1, "a message about sign-in links, with no token in it, is posted")
}
