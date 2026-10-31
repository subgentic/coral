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

// #11387: the Operator pauses Coral's notices to one agent and resumes them; nobody else can, and the live row says where it stands.
func TestPausingNoticesIsTheOperatorsAndShowsOnTheLiveRow(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-1387-1b00-0000-000000000001"
	name := "claude-" + sid
	terminal.addSession(name, "/w")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w"}))
	t.Cleanup(func() { ptymanager.ResumeNotices(sid) })
	call := func(client *http.Client, path, body string, tok string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/echo/notices/"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set(store.SessionTokenHeader, tok)
		}
		resp, err := client.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	row := func() map[string]any {
		resp, err := http.Get(server.URL + "/api/sessions/live")
		require.NoError(t, err)
		defer resp.Body.Close()
		var rows []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
		for _, r := range rows {
			if r["session_id"] == sid {
				return r
			}
		}
		t.Fatal("no row for the agent")
		return nil
	}
	pause := `{"agent_type":"claude","session_id":"` + sid + `"`

	// An agent (its own token), a script with no identity and a wrong target never pause anything.
	tok := agentToken(t, h, sid, name)
	code, out := call(http.DefaultClient, "pause", pause+`}`, tok)
	assert.Equal(t, http.StatusForbidden, code, "an agent's call is refused")
	assert.Equal(t, "operator_only", out["code"])
	code, out = call(http.DefaultClient, "pause", pause+`}`, "")
	assert.Equal(t, http.StatusForbidden, code, "a caller with no identity is refused")
	assert.Equal(t, "operator_only", out["code"])
	assert.False(t, ptymanager.NoticesHeld(sid), "a refused call held nothing")
	code, _ = call(operatorClient, "pause", `{"agent_type":"claude","session_id":"`+sid+`x"}`, "")
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = call(operatorClient, "pause", pause+`,"minutes":-1}`, "")
	assert.Equal(t, http.StatusBadRequest, code, "a negative length is refused")

	// The Operator: minutes left out is the default cap, never "until resumed".
	before := time.Now()
	code, out = call(operatorClient, "pause", pause+`}`, "")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["notices_paused"])
	until, err := time.Parse(time.RFC3339, out["paused_until"].(string))
	require.NoError(t, err)
	assert.WithinDuration(t, before.Add(ptymanager.DefaultNoticePause), until, 5*time.Second)
	assert.True(t, ptymanager.NoticesHeld(sid))
	r := row()
	assert.Equal(t, true, r["notices_paused"])
	assert.Equal(t, out["paused_until"], r["paused_until"])
	assert.EqualValues(t, 0, r["notices_waiting"])
	assert.Equal(t, false, r["notices_holding"])

	// A length is kept, and at most twelve hours.
	_, out = call(operatorClient, "pause", pause+`,"minutes":5}`, "")
	until, _ = time.Parse(time.RFC3339, out["paused_until"].(string))
	assert.WithinDuration(t, time.Now().Add(5*time.Minute), until, 5*time.Second)
	_, out = call(operatorClient, "pause", pause+`,"minutes":100000}`, "")
	until, _ = time.Parse(time.RFC3339, out["paused_until"].(string))
	assert.WithinDuration(t, time.Now().Add(ptymanager.MaxNoticePause), until, 5*time.Second)

	// Resume: an agent cannot, the Operator can, and the row is clear again.
	code, _ = call(http.DefaultClient, "resume", pause+`}`, tok)
	assert.Equal(t, http.StatusForbidden, code)
	assert.True(t, ptymanager.NoticesHeld(sid), "an agent's resume changed nothing")
	code, out = call(operatorClient, "resume", pause+`}`, "")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["notices_paused"])
	assert.Nil(t, out["paused_until"])
	assert.False(t, ptymanager.NoticesHeld(sid))
	r = row()
	assert.Equal(t, false, r["notices_paused"])
	assert.Nil(t, r["paused_until"])
}

// #11387: the turn-end hand-off is a notice too: held while the agent's notices are paused, then handed over.
func TestTurnEndHandoffWaitsWhileNoticesArePaused(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-1387-1c00-0000-000000000001"
	name := "claude-" + sid
	board := "team-1387"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w", BoardName: &board}))
	tok := agentToken(t, h, sid, name)
	_, err := h.bs.Subscribe(ctx, board, "Worker", "Worker", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, board, "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.PostMessage(ctx, board, "Lead", "@Worker please review #12", nil)
	require.NoError(t, err)
	t.Cleanup(func() { ptymanager.ResumeNotices(sid) })
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
	ptymanager.PauseNotices(sid, time.Hour)
	assert.Equal(t, false, ask()["handoff"], "paused: the hand-off waits")
	ptymanager.ResumeNotices(sid)
	assert.Equal(t, true, ask()["handoff"], "resumed: the unread messages are handed over")
}
