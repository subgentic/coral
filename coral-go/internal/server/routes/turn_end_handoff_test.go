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

	"github.com/subgentic/coral/internal/board"
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
		Text: "You have 1 unread message", What: "test",
		Send: func(context.Context) error { typed = true; return nil }})
	require.NoError(t, err)
	require.True(t, typed, "the nudge was typed (%v)", d)
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

// #10996 (c): while a person's send to the agent is in flight, or its text may still be in the agent's box, the hand-off does not start the agent's next turn: the person's Enter would be competing with it
// (#10992). It does once the send is over.
func TestTurnEndHandoffWaitsForAPersonsSend(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-0996-1c00-0000-000000000001"
	name := "claude-" + sid
	board := "team-0996c"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Worker", "Worker", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.PostMessage(ctx, board, "Lead", "@Worker please review #12", nil)
	require.NoError(t, err)
	ask := func() map[string]any {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/turn-end", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	end := ptymanager.BeginPersonSend(sid)
	assert.Equal(t, false, ask()["handoff"], "a person's send is in flight: no hand-off")
	end()
	ptymanager.NotePersonTextInBox(sid, true)
	assert.Equal(t, false, ask()["handoff"], "its text is still in the box: no hand-off")
	ptymanager.NotePersonTextInBox(sid, false)
	assert.Equal(t, true, ask()["handoff"], "nothing of a person's is pending: the hand-off goes")
}

// #10996 (a): the hand-off fires at most once per window per agent, so an agent that is flooded with board messages is not sent from turn to turn without a pause (a person's send could not land, #10992). A message that
// @mentions the agent, or is from the Operator, hands off at once; everything else waits for the window, as the notifier's reminder does.
func TestTurnEndHandoffIsOncePerWindowExceptAMentionOrTheOperator(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-0996-1a00-0000-000000000001"
	name := "claude-" + sid
	board := "team-0996a"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Orch", "Orchestrator", name, nil, "all") // an Orchestrator is told of every message; a worker only of its mentions
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	h.handoffs.setEvery(300 * time.Millisecond)
	ask := func() bool {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/turn-end", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out["handoff"] == true
	}
	read := func() { // what the agent's `coral-board read` does: its unread, mentions included, are read
		_, err := h.bs.ReadMessages(ctx, board, "Orch", 100)
		require.NoError(t, err)
	}
	post := func(who, text string) {
		_, err := h.bs.PostMessage(ctx, board, who, text, nil)
		require.NoError(t, err)
	}

	assert.False(t, ask(), "nothing unread: the turn ends")
	post("Lead", "fyi the build is green")
	assert.True(t, ask(), "the first hand-off goes at once")
	post("Lead", "fyi the second build is green")
	assert.False(t, ask(), "another plain message inside the window waits")
	assert.False(t, ask(), "and still waits")

	read()
	post("Lead", "@Orch please look at #12 now")
	assert.True(t, ask(), "a message that @mentions the agent hands off at once, inside the window")
	read()

	post("Lead", "fyi a third thing")
	assert.False(t, ask(), "plain again: inside the window it waits")
	post("Operator", "stop what you are doing")
	assert.True(t, ask(), "the Operator's message hands off at once")
	read()

	post("Lead", "fyi a fourth thing")
	time.Sleep(400 * time.Millisecond) // sleep-ok: the window is wall-clock time
	assert.True(t, ask(), "past the window the held messages are handed over")
}

// #11012: a copy from another board is posted with its recipients' @mentions, so it always read as a mention and the window never held a flood of them (and an agent on another board could keep a target in
// hand-offs with no pause). A mention is urgent only when it is local; a cross-board copy waits the short floor, a plain one the whole window; a local @mention and the Operator's message still go at once.
func TestTurnEndHandoffACrossBoardMentionIsNotUrgent(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-0996-1d00-0000-000000000001"
	name := "claude-" + sid
	board := "team-11012"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Orch", "Orchestrator", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	h.handoffs.setEvery(2 * time.Second)
	h.handoffs.setExternalFloor(250 * time.Millisecond)
	ask := func() bool {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/turn-end", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out["handoff"] == true
	}
	read := func() {
		_, err := h.bs.ReadMessages(ctx, board, "Orch", 100)
		require.NoError(t, err)
	}
	cross := func(text string, mentions ...string) {
		_, _, err := h.bs.PostCrossTeamMessage(ctx, crossTeamPost(board, text, mentions))
		require.NoError(t, err)
	}
	assert.False(t, ask(), "nothing unread")
	_, err = h.bs.PostMessage(ctx, board, "Lead", "fyi the build is green", nil)
	require.NoError(t, err)
	assert.True(t, ask(), "the first hand-off goes at once")
	read()

	cross("please act on this now", "Orch")
	assert.False(t, ask(), "a cross-board copy that @mentions the agent is held inside the floor")
	assert.False(t, ask(), "and still held")
	time.Sleep(300 * time.Millisecond) // sleep-ok: the floor is wall-clock time
	assert.True(t, ask(), "past the floor it is handed over, well inside the window")
	read()

	cross("a plain copy with no mention")
	time.Sleep(300 * time.Millisecond) // sleep-ok: past the floor
	assert.False(t, ask(), "a cross-board copy that mentions nobody waits the whole window")
	read()

	_, err = h.bs.PostMessage(ctx, board, "Lead", "@Orch urgent local thing", nil)
	require.NoError(t, err)
	assert.True(t, ask(), "a local @mention goes at once, inside the floor and the window")
	read()
	_, err = h.bs.PostMessage(ctx, board, "Operator", "stop", nil)
	require.NoError(t, err)
	assert.True(t, ask(), "the Operator's message goes at once")
}

func crossTeamPost(target, text string, mentions []string) board.CrossTeamPost {
	return board.CrossTeamPost{Origin: board.MessageOrigin{Board: "other-team", Sender: "Boss", SenderRole: "Orchestrator", TargetBoard: target}, Mentions: mentions, Content: text}
}
