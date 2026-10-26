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

// #7727: coral-board waiting lists what waits for an agent and types the nudge now, naming the exact session.
func TestWaitingListsAndSendsNow(t *testing.T) {
	const sid = "00000000-0000-0000-0000-0000000075b1"
	var mu sync.Mutex
	var posted []map[string]string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/board/team/subscribers":
			_, _ = w.Write([]byte(`[{"subscriber_id":"Other","session_name":"claude-` + sid + `","job_title":"Backend Dev"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/sessions/live/claude-"+sid+"/waiting":
			assert.Equal(t, "claude", r.URL.Query().Get("agent_type"))
			assert.Equal(t, sid, r.URL.Query().Get("session_id"))
			_, _ = w.Write([]byte(`{"board":"team","unread":1,"messages":[{"id":7,"sender":"Orch\u001b]0;pwned\u0007","at":"2026-10-25T11:40:00Z","text":"build it\nnow"}],"skipped":{"why":"a prompt or menu is open in the agent's terminal","what":"board message","at":"2026-10-25T11:41:00Z","since":"2026-10-25T11:40:00Z"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/sessions/live/claude-"+sid+"/waiting/send":
			b, _ := io.ReadAll(r.Body)
			var m map[string]string
			_ = json.Unmarshal(b, &m)
			mu.Lock()
			posted = append(posted, m)
			n := len(posted)
			mu.Unlock()
			if n == 2 {
				_, _ = w.Write([]byte(`{"ok":true,"sent":false,"draft_in_box":true}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"sent":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(s.Close)
	dir := subscribedDataDir(t, s.URL)

	run := runBoard(t, s.URL, dir, "waiting", "Backend Dev")
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "#7")
	assert.Contains(t, run.stdout, "build it now")
	assert.Contains(t, run.stdout, "a prompt or menu is open")
	assert.Empty(t, controls(run.stdout), "no terminal control from the server's text")
	assert.Contains(t, run.stdout, "middle of a turn")

	run = runBoard(t, s.URL, dir, "waiting", "send", "Backend Dev")
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "Sent now")
	mu.Lock()
	require.Len(t, posted, 1)
	assert.Equal(t, map[string]string{"agent_type": "claude", "session_id": sid}, posted[0])
	mu.Unlock()

	run = runBoard(t, s.URL, dir, "waiting", "send", "Backend Dev") // the server answers that a draft is in the box
	require.Zero(t, run.code, run.stderr)
	assert.Contains(t, run.stdout, "draft in the agent's input box")

	run = runBoard(t, s.URL, dir, "waiting", "send", "Nobody")
	assert.NotZero(t, run.code, "an agent that is not on the board is an error")
	mu.Lock()
	assert.Len(t, posted, 2)
	mu.Unlock()
}
