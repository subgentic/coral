package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// answerServer answers every request (but the health check) with reply, and records them.
func answerServer(t *testing.T, reply string) (*httptest.Server, func() []string) {
	var mu sync.Mutex
	var reqs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/health" {
			w.Write([]byte(`{"status":"ok","version":"test"}`))
			return
		}
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, r.Method+" "+r.URL.Path+" "+string(b))
		mu.Unlock()
		w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), reqs...) }
}

// #16135: 'Message #N posted' is the LAST line, so a '| tail -1' still shows the post went through (it used to be first, with the yes/no hint last, and an agent that cut the output
// thought the post failed and asked again).
func TestPostPrintsTheConfirmationLast(t *testing.T) {
	srv, _ := answerServer(t, `{"id": 77, "notified": ["Operator"], "ask": {"to": ["Operator"]}}`)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--ask", "@Operator Ship it?")
	require.Equal(t, 0, res.code, res.stderr)
	lines := strings.Split(strings.TrimSpace(res.stdout), "\n")
	require.Greater(t, len(lines), 1, "the hint is still printed")
	assert.Equal(t, "Message #77 posted to 'team'", lines[len(lines)-1])
}

// The server says the same question is still open: the CLI says so and does not claim a post; --again is sent when asked for.
func TestPostAskDuplicateIsSaidAndAgainIsSent(t *testing.T) {
	srv, reqs := answerServer(t, `{"id": 41, "duplicate": true, "message": "Already asked as #41; it is still open in Needs you."}`)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--ask", "@Operator Ship it?")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Already asked as #41; it is still open in Needs you.")
	assert.NotContains(t, res.stdout, "posted to")
	assert.NotContains(t, reqs()[0], `"again"`)

	res = runBoard(t, srv.URL, dir, "post", "--ask", "--again", "@Operator Ship it?")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, reqs()[1], `"again":true`)

	res = runBoard(t, srv.URL, dir, "post", "--again", "@Operator hi")
	assert.Equal(t, 2, res.code, "--again is for a question")
	assert.Len(t, reqs(), 2, "and sends nothing")
}

// post --withdraw N takes back my own question, as ask withdraw N does.
func TestPostWithdrawTakesBackMyQuestion(t *testing.T) {
	srv, reqs := answerServer(t, `{"ok": true}`)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--withdraw", "#210160")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Withdrew the question in message #210160.")
	require.Len(t, reqs(), 1)
	assert.Contains(t, reqs()[0], "POST /api/board/team/asks/210160/close ")
	assert.Contains(t, reqs()[0], `"withdraw":true`)

	for name, args := range map[string][]string{
		"no number":  {"post", "--withdraw", "x"},
		"with text":  {"post", "--withdraw", "5", "@Operator hi"},
		"with --ask": {"post", "--ask", "--withdraw", "5"},
		"no value":   {"post", "--withdraw"},
		"zero":       {"post", "--withdraw", "0"},
	} {
		r := runBoard(t, srv.URL, dir, args...)
		assert.Equal(t, 2, r.code, "%s: %s", name, r.stderr)
	}
	assert.Len(t, reqs(), 1, "a bad withdraw sends nothing")
}
