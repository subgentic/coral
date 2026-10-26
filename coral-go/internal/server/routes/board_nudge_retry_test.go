package routes

import (
	"context"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestBoardNudge8031TrustedStateChangeRetriesThroughTheGate(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := uuid.NewString()
	name := "codex-" + sid
	project := "retry-board"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "probe", AgentType: "codex", WorkingDir: "/fixture", BoardName: &project}))
	mock.addSession(name, "/fixture")
	term := &agentTerm{mockSessionTerminal: mock}
	h.terminal = term
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	term.show("Would you like to proceed?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel\n")
	var typed, kicks atomic.Int64
	deliver := func() {
		_, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{Term: term, Name: name, AgentType: "codex", SessionID: sid, Text: "You have 1 unread message", What: "board nudge", Send: func(context.Context) error { typed.Add(1); return nil }})
		if err != nil {
			t.Errorf("deliver: %v", err)
		}
	}
	deliver()
	require.Zero(t, typed.Load())
	bh := NewBoardHandler(h.bs)
	bh.SetNotifyFn(func(p string) {
		if p != project {
			t.Errorf("wrong board %q", p)
		}
		kicks.Add(1)
		deliver()
	})
	h.SetBoardHandler(bh)
	token := agentToken(t, h, sid, name)
	post := func(kind string) {
		t.Helper()
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/probe/events", strings.NewReader(`{"event_type":"`+kind+`","summary":"test transition"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, token)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, 200, resp.StatusCode)
	}
	post("permission_request")
	require.Zero(t, kicks.Load(), "opening a request does not retry")
	h.retrySkippedBoardNudge(ctx, sid, "codex-another-session", "stop")
	require.Zero(t, kicks.Load(), "another terminal cannot wake this session’s board")
	post("tool_use")
	require.EqualValues(t, 1, kicks.Load())
	require.Zero(t, typed.Load(), "a state hook never overrides the still-open screen")
	term.show("• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n")
	post("stop")
	require.EqualValues(t, 2, kicks.Load())
	require.EqualValues(t, 1, typed.Load(), "the ready transition retries the original skipped board nudge")
	post("stop")
	require.EqualValues(t, 2, kicks.Load(), "a delivered send cleared its skip memo; duplicate hooks do not rescan")
	require.EqualValues(t, 1, typed.Load())
}

// Security's #8031 follow-up, carried in #8040: only a board-nudge skip
// should wake the board notifier. A task reminder can use the same terminal
// gate and leave a skip memo, but it is not evidence of an undelivered nudge.
func TestBoardNudge8040TaskReminderMemoDoesNotWakeBoard(t *testing.T) {
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := uuid.NewString()
	name := "codex-" + sid
	project := "memo-kind-board"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "probe", AgentType: "codex", WorkingDir: "/fixture", BoardName: &project}))
	mock.addSession(name, "/fixture")
	term := &agentTerm{mockSessionTerminal: mock}
	h.terminal = term
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	var kicks atomic.Int64
	bh := NewBoardHandler(h.bs)
	bh.SetNotifyFn(func(string) { kicks.Add(1) })
	h.SetBoardHandler(bh)
	for _, what := range []string{"task reminder", "board nudge"} {
		term.show("Would you like to proceed?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel\n")
		delivery, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{Term: term, Name: name, AgentType: "codex", SessionID: sid, Text: "fixture notification", What: what, Send: func(context.Context) error { t.Error("nothing may be typed through the dialog"); return nil }})
		require.NoError(t, err)
		require.Equal(t, ptymanager.Skipped, delivery)
		memo, ok := ptymanager.SkippedOf(name)
		require.True(t, ok)
		require.Equal(t, what, memo.What)
		term.show("• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n")
		h.retrySkippedBoardNudge(ctx, sid, name, "request_resolved")
		if what == "task reminder" {
			require.Zero(t, kicks.Load())
		} else {
			require.EqualValues(t, 1, kicks.Load())
		}
	}
}
