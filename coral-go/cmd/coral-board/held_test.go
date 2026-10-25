package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7554: coral-board held lists what Coral holds for an agent and sends it now, naming the exact session.
func TestHeldListsAndSendsNow(t *testing.T) {
	const sid = "00000000-0000-0000-0000-0000000075b1"
	var mu sync.Mutex
	var posted []map[string]string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/board/team/subscribers":
			_, _ = w.Write([]byte(`[{"subscriber_id":"Other","session_name":"claude-` + sid + `","job_title":"Backend Dev"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/sessions/live/claude-"+sid+"/held":
			assert.Equal(t, "claude", r.URL.Query().Get("agent_type"))
			assert.Equal(t, sid, r.URL.Query().Get("session_id"))
			_, _ = w.Write([]byte(`{"held":[{"id":"abc123","what":"board message \u001b]0;pwned\u0007","since":"2026-10-25T11:40:00Z","reason":"prompt"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/sessions/live/claude-"+sid+"/held/send":
			b, _ := io.ReadAll(r.Body)
			var m map[string]string
			_ = json.Unmarshal(b, &m)
			mu.Lock()
			posted = append(posted, m)
			mu.Unlock()
			if len(posted) == 2 {
				_, _ = w.Write([]byte(`{"ok":true,"sent":0,"held_again":0,"dropped":0,"left":1,"draft_in_box":true}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"sent":1,"held_again":0,"dropped":0,"left":0}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(s.Close)
	dir := subscribedDataDir(t, s.URL)

	run := runBoard(t, s.URL, dir, "held", "Backend Dev")
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "abc123")
	assert.Contains(t, run.stdout, "board message")
	assert.Empty(t, controls(run.stdout), "no terminal control from the server's text")
	assert.Contains(t, run.stdout, "middle of a turn")

	run = runBoard(t, s.URL, dir, "held", "send", "Backend Dev", "--id", "abc123")
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "Sent 1 now")
	assert.Contains(t, run.stdout, "middle of a turn")
	count := func() int { mu.Lock(); defer mu.Unlock(); return len(posted) }
	mu.Lock()
	require.Len(t, posted, 1)
	assert.Equal(t, map[string]string{"agent_type": "claude", "session_id": sid, "id": "abc123"}, posted[0])
	mu.Unlock()

	run = runBoard(t, s.URL, dir, "held", "send", "Backend Dev") // all of it: the server answers that a draft is in the box
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "Sent 0 now")
	assert.Contains(t, run.stdout, "draft in the agent's input box: nothing was sent")
	require.Equal(t, 2, count())
	mu.Lock()
	assert.Equal(t, "", posted[1]["id"])
	mu.Unlock()

	run = runBoard(t, s.URL, dir, "held", "send", "Nobody")
	assert.NotZero(t, run.code, "an agent that is not on the board is an error")
	assert.Equal(t, 2, count())
}
