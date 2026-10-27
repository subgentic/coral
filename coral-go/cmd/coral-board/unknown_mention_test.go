package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
