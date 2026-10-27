package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The server refuses a post that @mentions nobody on the board (#9047): the CLI exits 1 and prints the server's message, which names the
// mention and the way to reach another team. It does not print "Message #N posted".
func TestPostPrintsAndFailsOnAnUnknownMention(t *testing.T) {
	msg := `not posted: no subscriber named 'Orchestrator (coral-hub)': that is a sender on another team's board; message it with: coral-board send --board coral-hub "..."`
	answer, _ := json.Marshal(map[string]any{"error": msg, "message": msg, "code": "unknown_mention", "not_sent": true})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write(answer)
	}))
	defer srv.Close()
	res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), "post", "@Orchestrator (coral-hub) hello")
	assert.Equal(t, 1, res.code, "stderr: %q", res.stderr)
	assert.Contains(t, res.stderr, msg)
	assert.NotContains(t, res.stdout, "posted to")
}

// post --assign asks the server to check the post before it creates the task: a refused post leaves no task behind (#9047).
func TestPostAssignChecksMentionsBeforeCreatingTheTask(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	msg := "not posted: no subscriber named 'Nobody'"
	answer, _ := json.Marshal(map[string]any{"error": msg, "message": msg, "code": "unknown_mention", "not_sent": true})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+string(b))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/messages") && strings.Contains(string(b), `"dry_run":true`) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write(answer)
			return
		}
		w.Write([]byte(`{"id":1}`))
	}))
	defer srv.Close()
	res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), "post", "--assign", "Dev", "--goal", "7", "@Nobody please build it")
	assert.Equal(t, 1, res.code, "stderr: %q", res.stderr)
	assert.Contains(t, res.stderr, msg)
	mu.Lock()
	defer mu.Unlock()
	for _, line := range seen {
		assert.False(t, strings.HasPrefix(line, "POST ") && strings.HasSuffix(strings.SplitN(line, " ", 3)[1], "/tasks"), "no task was created: %s", line)
	}
}
