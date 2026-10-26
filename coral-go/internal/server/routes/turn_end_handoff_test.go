package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #3481 phase 1B (#3475 3A): when a Claude team agent's turn ends with unread board
// messages, its Stop hook is told to keep it going with them, and the nudge Coral held
// for the same messages is retired, never typed. Only the agent's own hook may ask, once
// per stop chain; an agent with no board, another CLI, or the setting off get nothing.
func TestTurnEndHandoff(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-3481-1b00-0000-000000000005"
	name := "claude-" + sid
	board := "team-3481"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Worker", "Worker", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)

	ask := func(body, tok string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/turn-end", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set(store.SessionTokenHeader, tok)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	code, _ := ask(`{}`, "")
	assert.Equal(t, http.StatusUnauthorized, code)
	_, out := ask(`{}`, tok)
	assert.Equal(t, false, out["handoff"], "nothing unread: the turn ends")

	_, err = h.bs.PostMessage(ctx, board, "Lead", "@Worker please review #12", nil)
	require.NoError(t, err)
	_, out = ask(`{"stop_hook_active":true}`, tok)
	assert.Equal(t, false, out["handoff"], "at most once per stop chain")

	_, out = ask(`{}`, tok)
	require.Equal(t, true, out["handoff"])
	assert.Equal(t, "New board messages", out["reason"])
	assert.Contains(t, out["context"], "1 new message on "+board)
	assert.Contains(t, out["context"], "coral-board read")

	// The setting off, or an agent with no board (a person drives it): no hand-off.
	require.NoError(t, ss.SetSetting(ctx, TurnEndHandoffSetting, "off"))
	_, out = ask(`{}`, tok)
	assert.Equal(t, false, out["handoff"], "turned off")
	require.NoError(t, ss.SetSetting(ctx, TurnEndHandoffSetting, "on"))
	sid2 := "eeeeeeee-3481-1b00-0000-000000000006"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "claude", AgentName: "solo", WorkingDir: "/w"}))
	_, out = ask(`{}`, agentToken(t, h, sid2, "claude-"+sid2))
	assert.Equal(t, false, out["handoff"], "no board")
}

// idleBox is an agent at its empty input box: the gate types into it.
type idleBox struct{}

func (idleBox) AgentScreen(context.Context, string, string, string) (string, error) {
	return "⏺ Done.\n\n──────────────────────────────────────────\n❯ \n──────────────────────────────────────────\n  ? for shortcuts\n", nil
}

// A real gate delivery does not acknowledge the board messages (#8557): after
// a nudge typed mid-turn and another prompt_submit, unread messages still hand off.
func TestTurnEndHandoffAfterARealTypedNudge(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-3510-0000-0000-000000000002"
	name := "claude-" + sid
	board := "team-3510b"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "hotel", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Worker", "Worker", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	t.Cleanup(func() { ptymanager.ForgetSession(name) })

	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "hotel", SessionID: &sid, EventType: "prompt_submit", Summary: "User submitted prompt",
		CreatedAt: time.Now().UTC().Add(-2 * time.Second).Format(store.ISOFormat)})
	require.NoError(t, err)

	_, err = h.bs.PostMessage(ctx, board, "Lead", "@Worker mid-turn message", nil)
	require.NoError(t, err)
	typed := false
	d, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{Term: idleBox{}, Name: name, AgentType: "claude", SessionID: sid,
		Key: "board-unread:" + board, Text: "You have 1 unread message", What: "test",
		Send: func(context.Context) error { typed = true; return nil }})
	require.NoError(t, err)
	require.True(t, typed, "the nudge was typed (%v)", d)
	require.False(t, ptymanager.LastDelivered(name, "board-unread:"+board).IsZero())
	// As Claude 2.1.300 does: a prompt_submit for the queued nudge, just after it was typed.
	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "hotel", SessionID: &sid, EventType: "prompt_submit", Summary: "queued",
		CreatedAt: time.Now().UTC().Add(400 * time.Millisecond).Format(store.ISOFormat)})
	require.NoError(t, err)

	req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/hotel/turn-end", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(store.SessionTokenHeader, tok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	assert.Equal(t, true, out["handoff"], "the board remains unread despite the typed nudge: hand off now")
}
