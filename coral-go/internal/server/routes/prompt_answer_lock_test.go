package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A person's answer takes the lock of the agent's SESSION id, the key the dialog close, the pick and auto-accept take (agent_lock.go), so it cannot answer a prompt one of them is closing at that moment.
func TestAPersonsAnswerWaitsForTheLockTheWatchersHold(t *testing.T) {
	const sid = "00000000-0000-0000-0000-00000000a1a1"
	server, handler, term, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "lock-agent", WorkingDir: "/tmp/test"}))
	term.addSession("lock-agent", "/tmp/test")
	unlock, ok := handler.tryLockAgent(sid) // a watcher's close or pick is in progress
	require.True(t, ok)

	done := make(chan int, 1)
	go func() {
		b, _ := json.Marshal(map[string]any{"n": 1, "label": "Yes", "session_id": sid, "agent_type": "claude"})
		resp, err := http.Post(server.URL+"/api/sessions/live/lock-agent/answer-prompt", "application/json", bytes.NewReader(b))
		if err != nil {
			done <- -1
			return
		}
		defer resp.Body.Close()
		done <- resp.StatusCode
	}()
	select {
	case code := <-done:
		unlock()
		t.Fatalf("the answer went (status %d) while a watcher held the session's lock", code)
	case <-time.After(300 * time.Millisecond):
	}
	unlock()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the answer never got the lock")
	}
	assert.Zero(t, handler.locks.size(), "no lock entry is left behind")
}

// An answer that does not name its session is refused before any lock is taken: there is no name-keyed lock for it to hold while a watcher holds the session's.
func TestAnAnswerWithNoSessionIdIsRefusedBeforeAnyLock(t *testing.T) {
	server, handler, term, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "00000000-0000-0000-0000-00000000a2a2", AgentType: "claude", AgentName: "lock-agent", WorkingDir: "/tmp/test"}))
	term.addSession("lock-agent", "/tmp/test")
	b, _ := json.Marshal(map[string]any{"n": 1, "label": "Yes", "agent_type": "claude"})
	resp, err := http.Post(server.URL+"/api/sessions/live/lock-agent/answer-prompt", "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "a name alone does not name the target")
	assert.Zero(t, handler.locks.size(), "and no lock, by name or otherwise, was taken")
}
