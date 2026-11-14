package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/clitext"
)

// #16186: `post --ask "@Operator -" <<EOF` sends the literal "-" (stdin is read only when "-" is the whole message), and Needs you showed a bare bullet. A post with no words
// is refused before anything is sent, with the way to fix it.
func TestPostWithNoWordsIsRefusedAndNothingIsSent(t *testing.T) {
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/health" {
			w.Write([]byte(`{"status":"ok","version":"test"}`))
			return
		}
		posts.Add(1)
		w.Write([]byte(`{"id": 5}`))
	}))
	t.Cleanup(srv.Close)
	dir := subscribedDataDir(t, srv.URL)
	for _, c := range []struct {
		stdin string
		args  []string
	}{
		{"", []string{"post", "--ask", "@Operator", "-"}}, {"", []string{"post", "@Operator", "-"}}, {"@Operator -\n", []string{"post", "--ask", "-"}}, {"", []string{"post", "--", "-"}},
	} {
		args := c.args
		res := runBoardInput(t, srv.URL, dir, strings.NewReader(c.stdin), args...)
		assert.NotEqual(t, 0, res.code, args)
		assert.Equal(t, "Error: "+clitext.WordlessGuidance, strings.TrimSpace(res.stderr), args)
	}
	assert.Zero(t, posts.Load(), "nothing reached the server")

	res := runBoardInput(t, srv.URL, dir, strings.NewReader(""), "post", "@Operator - is the build green?")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Equal(t, int32(1), posts.Load(), "real words still post")
}
