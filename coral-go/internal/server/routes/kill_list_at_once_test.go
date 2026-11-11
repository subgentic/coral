package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// slowKillTerminal holds KillSession until released: the terminal's end of a kill can take seconds (tmux, a process that will not exit).
type slowKillTerminal struct {
	*mockSessionTerminal
	entered chan struct{}
	release chan struct{}
}

func (s *slowKillTerminal) KillSession(ctx context.Context, name, agentType, sessionID string) error {
	close(s.entered)
	<-s.release
	return s.mockSessionTerminal.KillSession(ctx, name, agentType, sessionID)
}

// #15370 (user feedback): a killed agent's row stayed in the list for seconds. The server took the session's row out of its store before it killed the terminal, but told the dashboards (kickWS) only when the whole kill, the terminal's end
// and the worktree's, was over. The feed is pushed as soon as the row is gone.
func TestAKilledAgentLeavesTheListBeforeItsTerminalIsDone(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000015370"
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-"+sid, "/tmp/test")
	slow := &slowKillTerminal{mockSessionTerminal: terminal, entered: make(chan struct{}), release: make(chan struct{})}
	h.terminal = slow
	kicks := func() uint64 { h.wsList.mu.Lock(); defer h.wsList.mu.Unlock(); return h.wsList.kickGen }
	before := kicks()

	done := make(chan int, 1)
	go func() {
		resp, err := http.Post(server.URL+"/api/sessions/live/claude-"+sid+"/kill", "application/json", bytes.NewBufferString(`{"agent_type":"claude","session_id":"`+sid+`"}`))
		if err != nil {
			done <- -1
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	select {
	case <-slow.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the kill never reached the terminal")
	}
	live, err := ss.GetLiveSession(ctx, sid)
	assert.True(t, err != nil || live == nil || live.Status == "inactive", "the row is gone from the store while the terminal is still being killed")
	assert.Greater(t, kicks(), before, "the dashboards were told the list changed while the terminal is still being killed, not only when the whole kill ends")
	close(slow.release)
	select {
	case code := <-done:
		assert.Equal(t, http.StatusOK, code)
	case <-time.After(5 * time.Second):
		t.Fatal("the kill never answered")
	}
}

// errKillTerminal answers every KillSession with err.
type errKillTerminal struct {
	*mockSessionTerminal
	err error
}

func (e *errKillTerminal) KillSession(context.Context, string, string, string) error { return e.err }

// #15431 (Security's INFO on #15370): the row is out of the list before the terminal is ended, so a terminal that would not end must not be answered "ok": the person is told, and the orphan sweep ends it. A terminal that
// is already gone is not a failure.
func TestAKillWhoseTerminalWillNotEndSaysSoAndOneAlreadyGoneIsOk(t *testing.T) {
	for _, c := range []struct {
		name   string
		err    error
		status int
		ok     bool
	}{{"will not end", errors.New("kill-session failed: exit 1"), http.StatusInternalServerError, false}, {"already gone", ptymanager.ErrTerminalGone, http.StatusOK, true}} {
		t.Run(c.name, func(t *testing.T) {
			server, h, terminal, ss := setupSessionsTestServer(t)
			const sid = "00000000-0000-0000-0000-000000015431"
			require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))
			terminal.addSession("claude-"+sid, "/tmp/test")
			h.terminal = &errKillTerminal{mockSessionTerminal: terminal, err: c.err}
			resp, err := http.Post(server.URL+"/api/sessions/live/claude-"+sid+"/kill", "application/json", bytes.NewBufferString(`{"agent_type":"claude","session_id":"`+sid+`"}`))
			require.NoError(t, err)
			defer resp.Body.Close()
			var out map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
			assert.Equal(t, c.status, resp.StatusCode)
			assert.Equal(t, c.ok, out["ok"])
			if !c.ok {
				assert.Contains(t, out["error"], "Kill failed")
				assert.NotContains(t, out["error"], "exit 1", "the raw error is logged, not shown")
			} else {
				assert.NotContains(t, out, "error")
			}
		})
	}
}
