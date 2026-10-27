package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

func TestRestartPreservesSubscriptionWithoutStoredBoard(t *testing.T) {
	t.Parallel() // no shared state: these ran one after another (#5622)
	server, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const oldID = "restart-board-worker"
	const oldName = "codex-" + oldID
	term.addSession(oldName, t.TempDir())
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: oldID, AgentType: "codex", AgentName: "coral-go", DisplayName: ptr.NonEmpty("UI"),
	}))
	_, err := handler.bs.Subscribe(ctx, "coral-task-workflows", "UI", "UI", oldName, nil, "all", true)
	require.NoError(t, err)
	// A same-role subscription on another board must not be migrated.
	_, err = handler.bs.Subscribe(ctx, "other-board", "UI", "UI", "codex-other", nil, "mentions")
	require.NoError(t, err)
	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json",
		bytes.NewBufferString(`{"session_id":"restart-board-worker","agent_type":"codex"}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var result struct {
		SessionID   string `json:"session_id"`
		SessionName string `json:"session_name"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	ls, err := ss.GetLiveSession(ctx, result.SessionID)
	require.NoError(t, err)
	require.NotNil(t, ls)
	assert.Equal(t, "coral-task-workflows", ptr.Value(ls.BoardName))
	sub, err := handler.bs.GetSubscriptionBySessionName(ctx, result.SessionName)
	require.NoError(t, err)
	require.NotNil(t, sub)
	assert.Equal(t, "UI", sub.SubscriberID)
	assert.Equal(t, "all", sub.ReceiveMode)
	assert.Equal(t, 1, sub.CanPeek)
	old, err := handler.bs.GetSubscriptionBySessionName(ctx, oldName)
	require.NoError(t, err)
	assert.Nil(t, old)
	other, err := handler.bs.GetSubscriptionBySessionName(ctx, "codex-other")
	require.NoError(t, err)
	require.NotNil(t, other)
	assert.Equal(t, "other-board", other.Project)
}

// The membership part of the removed tests/stress/test_team_restart.py (#3811): a board-only
// membership (joined through the board API, not at launch) survives two restarts in a row: one
// subscription, the same row, role and receive mode, targeting the newest terminal, and the
// session keeps its board and display name.
func TestRestartTwiceKeepsBoardMembership(t *testing.T) {
	t.Parallel() // no shared state: these ran one after another (#5622)
	server, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	id, name := "restart-twice-ui", "claude-restart-twice-ui"
	term.addSession(name, t.TempDir())
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: id, AgentType: "claude", AgentName: "coral-go", DisplayName: ptr.NonEmpty("UI"),
	}))
	original, err := handler.bs.Subscribe(ctx, "restart-membership", "UI", "UI", name, nil, "all")
	require.NoError(t, err)
	for attempt := 1; attempt <= 2; attempt++ {
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/restart", "application/json",
			bytes.NewBufferString(`{"session_id":"`+id+`","agent_type":"claude"}`))
		require.NoError(t, err)
		var result struct {
			SessionID   string `json:"session_id"`
			SessionName string `json:"session_name"`
		}
		require.Equal(t, http.StatusOK, resp.StatusCode, "restart %d", attempt)
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
		resp.Body.Close()
		require.NotEqual(t, id, result.SessionID, "restart %d: a new session", attempt)
		id, name = result.SessionID, result.SessionName
		term.addSession(name, t.TempDir()) // the new terminal, for the next restart

		ls, err := ss.GetLiveSession(ctx, id)
		require.NoError(t, err)
		require.NotNil(t, ls)
		assert.Equal(t, "restart-membership", ptr.Value(ls.BoardName), "restart %d keeps the board", attempt)
		assert.Equal(t, "UI", ptr.Value(ls.DisplayName), "restart %d keeps the display name", attempt)
		subs, err := handler.bs.ListSubscribers(ctx, "restart-membership")
		require.NoError(t, err)
		require.Len(t, subs, 1, "restart %d: one subscription", attempt)
		assert.Equal(t, original.ID, subs[0].ID, "restart %d keeps the same membership row", attempt)
		assert.Equal(t, "UI", subs[0].SubscriberID)
		assert.Equal(t, "UI", subs[0].JobTitle)
		assert.Equal(t, "all", subs[0].ReceiveMode)
		assert.Equal(t, name, subs[0].SessionName, "restart %d: it targets the new terminal", attempt)
	}
}

// A restart may switch the provider (#8973): the agent keeps its name, role, board and prompt, the old terminal is found by the type it runs on (not the one it is going to), and the new session is the new
// provider's, subscribed to the same board under the same name.
func TestRestartSwitchesTheProviderAndKeepsNameBoardAndPrompt(t *testing.T) {
	t.Parallel()
	server, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const oldID = "switch-worker"
	const oldName = "claude-" + oldID
	term.addSession(oldName, t.TempDir())
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: oldID, AgentType: "claude", AgentName: "coral-go", DisplayName: ptr.NonEmpty("Reviewer"), Prompt: ptr.NonEmpty("You review the work."),
		BoardName: ptr.NonEmpty("coral-go-team"), Flags: store.MarshalFlags([]string{"--verbose-claude-only"}),
	}))
	_, err := handler.bs.Subscribe(ctx, "coral-go-team", "Reviewer", "Reviewer", oldName, nil, "all", true)
	require.NoError(t, err)
	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json",
		bytes.NewBufferString(`{"session_id":"switch-worker","agent_type":"codex","model":""}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var result struct {
		SessionID   string `json:"session_id"`
		SessionName string `json:"session_name"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	assert.Equal(t, "codex-"+result.SessionID, result.SessionName, "the new session is the new provider's")
	ls, err := ss.GetLiveSession(ctx, result.SessionID)
	require.NoError(t, err)
	require.NotNil(t, ls)
	assert.Equal(t, "codex", ls.AgentType)
	assert.NotContains(t, ptr.Value(ls.Flags), "--verbose-claude-only", "the old provider's flags do not carry to the new one")
	assert.Equal(t, "coral-go-team", ptr.Value(ls.BoardName), "the board is kept")
	assert.Equal(t, "You review the work.", ptr.Value(ls.Prompt), "the prompt is kept")
	assert.Equal(t, "Reviewer", ptr.Value(ls.DisplayName), "the name is kept")
	sub, err := handler.bs.GetSubscriptionBySessionName(ctx, result.SessionName)
	require.NoError(t, err)
	require.NotNil(t, sub)
	assert.Equal(t, "Reviewer", sub.SubscriberID, "the role on the board is kept")
	old, err := handler.bs.GetSubscriptionBySessionName(ctx, oldName)
	require.NoError(t, err)
	assert.Nil(t, old, "the old provider's subscription is gone")
	term.mu.Lock()
	defer term.mu.Unlock()
	require.NotEmpty(t, term.findTypes)
	for _, ty := range term.findTypes {
		assert.Equal(t, "claude", ty, "the old terminal is found by the provider it runs on, not the one it is going to run on")
	}
}

// A switch that leaves a stale model in place is refused before anything is touched, and the reason is the answer the person reads (#8973, #8990): the old agent keeps running.
func TestRestartSwitchRefusesAStaleModelAndLeavesTheAgentRunning(t *testing.T) {
	t.Parallel()
	server, _, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const oldID = "switch-stale"
	const oldName = "claude-" + oldID
	term.addSession(oldName, t.TempDir())
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: oldID, AgentType: "claude", AgentName: "coral-go", Model: ptr.NonEmpty("claude-opus-4"),
	}))
	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json",
		bytes.NewBufferString(`{"session_id":"switch-stale","agent_type":"codex"}`)) // no model sent: the stored Claude one would carry to Codex
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Contains(t, body.Error, "claude-opus-4", "the answer names the stale model, for the person to read")
	ls, err := ss.GetLiveSession(ctx, oldID)
	require.NoError(t, err)
	require.NotNil(t, ls)
	assert.Equal(t, "claude", ls.AgentType, "the old agent is untouched")
	assert.Empty(t, term.sentCommands(), "nothing was sent to any terminal")
}

// gemini, antigravity and agy are one provider: a restart from one to another keeps the agent's stored flags (it is not a switch), while a real switch drops them (#9003).
func TestRestartProviderAliasesAreNotASwitch(t *testing.T) {
	t.Parallel()
	server, _, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const oldID = "alias-worker"
	const oldName = "gemini-" + oldID
	term.addSession(oldName, t.TempDir())
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: oldID, AgentType: "gemini", AgentName: "coral-go", Flags: store.MarshalFlags([]string{"--kept-flag"}),
	}))
	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json",
		bytes.NewBufferString(`{"session_id":"alias-worker","agent_type":"agy","model":""}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var result struct {
		SessionID string `json:"session_id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	ls, err := ss.GetLiveSession(ctx, result.SessionID)
	require.NoError(t, err)
	require.NotNil(t, ls)
	assert.Contains(t, ptr.Value(ls.Flags), "--kept-flag", "gemini to agy is the same provider: the flags are kept")
}

// The alias pairs the first test does not cover: antigravity to agy and agy to gemini are not a switch either, and a real switch drops the flags (#9003, review pin).
func TestRestartProviderAliasPairsKeepTheFlagsAndARealSwitchDropsThem(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		from, to string
		kept     bool
	}{
		{"antigravity", "agy", true},
		{"agy", "gemini", true},
		{"agy", "antigravity", true},
		{"gemini", "claude", false},
		{"agy", "codex", false},
	} {
		t.Run(c.from+"_to_"+c.to, func(t *testing.T) {
			t.Parallel()
			server, _, term, ss := setupSessionsTestServer(t)
			ctx := context.Background()
			const id = "pair-worker"
			term.addSession(c.from+"-"+id, t.TempDir())
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
				SessionID: id, AgentType: c.from, AgentName: "coral-go", Flags: store.MarshalFlags([]string{"--kept-flag"}),
			}))
			resp, err := http.Post(server.URL+"/api/sessions/live/"+c.from+"-"+id+"/restart", "application/json",
				bytes.NewBufferString(`{"session_id":"`+id+`","agent_type":"`+c.to+`","model":""}`))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var result struct {
				SessionID string `json:"session_id"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
			ls, err := ss.GetLiveSession(ctx, result.SessionID)
			require.NoError(t, err)
			require.NotNil(t, ls)
			if c.kept {
				assert.Contains(t, ptr.Value(ls.Flags), "--kept-flag", "%s to %s is one provider: the flags are kept", c.from, c.to)
			} else {
				assert.NotContains(t, ptr.Value(ls.Flags), "--kept-flag", "%s to %s is a switch: the flags belong to the old CLI", c.from, c.to)
			}
		})
	}
}
