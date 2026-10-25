package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #7420: the feed waited for its next 5 s tick to show a Codex row's request open or closed, so a request that Codex's reviewer settled in 3 s was still on the row when the dashboard's 4 s hold ended.
// A hook event that opens or closes a request now kicks the feed (a coral_diff within a moment), and only those: a tool_use is one per tool call, so it kicks only when it closes a request.
func TestAnAgentEventThatOpensOrClosesARequestKicksTheFeed(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "aaaaaaaa-7420-0000-0000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "alpha", WorkingDir: "/tmp/x"}))
	tok := agentToken(t, h, sid, "codex-"+sid)
	kicks, cancel := h.wsKick.subscribe()
	defer cancel()
	post := func(body string) {
		t.Helper()
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/alpha/events", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
	}
	kicked := func() bool {
		select {
		case <-kicks:
			return true
		case <-time.After(200 * time.Millisecond): // sleep-ok: a negative needs a wait; the positive returns at once
			return false
		}
	}
	req := `{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","tool_name":"Bash"}}`
	tool := `{"event_type":"tool_use","summary":"Ran: coral-board read","tool_name":"Bash"}`

	post(tool)
	assert.False(t, kicked(), "a tool call with no request open kicks nothing: one per tool call")
	post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	assert.False(t, kicked(), "a prompt with no request open kicks nothing")

	post(req)
	assert.True(t, kicked(), "a request opening is on the feed at once")
	assert.True(t, h.deriveSingleSessionState(ctx, sid, 0).NeedsInput)
	post(tool)
	assert.True(t, kicked(), "the tool running closes it: on the feed at once, not on the next tick")
	assert.False(t, h.deriveSingleSessionState(ctx, sid, 0).NeedsInput)
	post(tool)
	assert.False(t, kicked(), "and the next tool call kicks nothing again")

	post(req)
	require.True(t, kicked())
	post(`{"event_type":"stop","summary":"Agent stopped: unknown"}`)
	assert.True(t, kicked(), "a turn that ends over an open request closes it: kicked")
	post(`{"event_type":"stop","summary":"Agent stopped: unknown"}`)
	assert.False(t, kicked(), "a stop with no request open kicks nothing")
}
