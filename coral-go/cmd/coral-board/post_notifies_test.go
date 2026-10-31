package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A post that notifies nobody is refused (#11441): three handoffs stalled because a result was posted with no @mention.
func TestAPostThatNotifiesNobodyIsRefused(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	for name, args := range map[string][]string{
		"no mention":               {"post", "Result is ready"},
		"an address is no mention": {"post", "Mail me at dev@example.com"},
		"a lone at sign":           {"post", "look @ this"},
		"a mention inside a word":  {"post", "foo@bar baz"},
		"an empty --to":            {"post", "--to", "", "Result is ready"},
	} {
		res := runBoard(t, srv.URL, dir, args...)
		assert.NotEqual(t, 0, res.code, "%s: refused", name)
		assert.Equal(t, "Error: this post notifies nobody: add @Name, --to, or --task\n", res.stderr, name)
	}
	assert.Empty(t, srv.requests(), "a refused post sends nothing")
}

func TestAPostThatReachesSomeoneIsNotRefused(t *testing.T) {
	for name, args := range map[string][]string{
		"an @Name":         {"post", "@Dev A the result is ready"},
		"@Name at the end": {"post", "ready for you @Lead"},
		"--to":             {"post", "--to", "Dev A", "the result is ready"},
		"--task":           {"post", "--task", "12", "the result is ready"},
		"--reply-to":       {"post", "--reply-to", "7", "the result is ready"},
		"a name in a list": {"post", "ready (@Lead, @QA)"},
	} {
		srv := newRecordingServer(t)
		res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), args...)
		require.Equal(t, 0, res.code, "%s: %q", name, res.stderr)
		assert.Len(t, srv.requests(), 1, name)
	}
}

// The operator's own opt-out is not offered anywhere an agent reads: not in the error, the usage or a "did you mean".
func TestTheBroadcastOptOutWorksAndIsNotAdvertised(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--broadcast", "status for no one")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.requests(), 1)
	assert.Contains(t, srv.requests()[0], `"content":"status for no one"`)
	assert.NotContains(t, srv.requests()[0], "broadcast", "the flag is not part of the post")

	for _, args := range [][]string{{"post", "no mention here"}, {"post", "--broadcas", "x"}, {"post", "--help"}, {"help"}, {"help", "post"}} {
		res := runBoard(t, srv.URL, dir, args...)
		assert.NotContains(t, strings.ToLower(res.stdout+res.stderr), "broadcast", "%v", args)
		assert.NotContains(t, strings.ToLower(res.stdout+res.stderr), "--fyi", "%v", args)
	}
}

// When the text names a task, the refusal suggests who it belongs to.
func TestTheRefusalSuggestsWhoOwnsTheTaskTheTextNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/health":
			w.Write([]byte(`{"status":"ok","version":"test"}`))
		case "/api/board/team/tasks/12":
			w.Write([]byte(`{"task":{"id":12,"assigned_to":"Dev A","created_by":"Orchestrator"}}`))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":"not found"}`))
		}
	}))
	defer srv.Close()
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "The fix for #12 is done")
	assert.NotEqual(t, 0, res.code)
	assert.Contains(t, res.stderr, "this post notifies nobody: add @Name, --to, or --task")
	assert.Contains(t, res.stderr, "did you mean @Dev A?", res.stderr)
	assert.NotContains(t, res.stderr, "@Orchestrator", "the assignee, else the creator")

	res = runBoard(t, srv.URL, dir, "post", "Nothing about #99 here")
	assert.NotContains(t, res.stderr, "did you mean", "a task that cannot be read suggests nothing")
}

// --assign makes a task for someone, who is told: a post with it and no @Name is not refused (QA Engineer's SHOULD on #11441).
func TestAnAssignPostWithNoMentionIsNotRefused(t *testing.T) {
	srv := newRecordingServer(t)
	res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), "post", "--assign", "Dev A", "--goal", "1", "build the parser")
	require.Equal(t, 0, res.code, res.stderr)
	assert.NotContains(t, res.stderr, "notifies nobody")
	assert.NotEmpty(t, srv.requests(), "the task and the post were sent")
}
