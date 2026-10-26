package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Looking at what waits for an agent changes nothing for the agent (#7727, Security's #7757 read): the page lists its unread board messages, and they stay unread.
func TestListingWhatWaitsForAnAgentLeavesItsMessagesUnread(t *testing.T) {
	waitingLookLeavesUnread(t, "mentions", []string{"@Worker first", "@Worker second"}, 2)
}

// The same for an agent in receive mode all (#7757, the operator): it is counted, and shown, only what its plain read returns, the messages that tag it and the ones to @all; a message that tags nobody
// is neither counted nor nudged, so the page says what the nudge says.
func TestTheWaitingPageListsWhatAPlainReadReturnsForAnAgentInModeAll(t *testing.T) {
	waitingLookLeavesUnread(t, "all", []string{"an update that tags nobody", "@Worker tagged", "@all for everyone"}, 2)
}

func waitingLookLeavesUnread(t *testing.T, mode string, texts []string, want int) {
	t.Helper()
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "11111111-2222-3333-4444-555555555555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "Worker", AgentType: "claude", WorkingDir: t.TempDir()}))
	name := naming.SessionName("claude", sid)
	_, err := h.bs.Subscribe(ctx, "alpha", "Worker", "Backend", name, nil, mode)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	for _, text := range texts {
		_, err = h.bs.PostMessage(ctx, "alpha", "Lead", text, nil)
		require.NoError(t, err)
	}
	unread := func() int { n, _ := h.bs.CheckUnread(ctx, "alpha", "Worker"); return n }
	require.Equal(t, want, unread())
	for _, routeName := range []string{name, "Worker"} {
		for i := 0; i < 2; i++ { // both API and dashboard names, twice: looking never consumes the messages
			resp, err := http.Get(server.URL + "/api/sessions/live/" + routeName + "/waiting?agent_type=claude&session_id=" + sid)
			require.NoError(t, err)
			var out struct {
				Unread   int              `json:"unread"`
				Messages []map[string]any `json:"messages"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
			resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			assert.Equal(t, want, out.Unread, "look %d", i)
			assert.Len(t, out.Messages, want, "look %d lists what a plain read returns", i)
			assert.Equal(t, want, unread(), "look %d: the agent still has them unread", i)
		}
	}
}

// The dashboard uses the folder name, which may be shared by sibling sessions.
// Send now must resolve its board and terminal from the already validated ID.
func TestSendWaitingFromDashboardUsesExactSession(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	name := naming.SessionName("claude", gateSID)
	siblingID := "22222222-2222-3333-4444-555555555555"
	sibling := naming.SessionName("claude", siblingID)
	for _, sid := range []string{gateSID, siblingID} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "repo", WorkingDir: t.TempDir()}))
	}
	mock.addSession(name, "/tmp/test")
	mock.addSession(sibling, "/tmp/sibling")
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: idleInputBox}
	term.setFG(name, "node")
	h.terminal = term
	_, err := h.bs.Subscribe(ctx, "alpha", "Worker", "Backend", name, nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.PostMessage(ctx, "alpha", "Lead", "@Worker dashboard send", nil)
	require.NoError(t, err)
	resp, err := http.Post(server.URL+"/api/sessions/live/repo/waiting/send", "application/json", strings.NewReader(`{"agent_type":"claude","session_id":"`+gateSID+`"}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Equal(t, http.StatusOK, resp.StatusCode, out)
	assert.Equal(t, true, out["sent"])
	mock.mu.Lock()
	defer mock.mu.Unlock()
	assert.NotEmpty(t, mock.sent[name])
	assert.Empty(t, mock.sent["repo"])
	assert.Empty(t, mock.sent[sibling])
}
