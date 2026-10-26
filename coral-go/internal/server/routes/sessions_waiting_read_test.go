package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Looking at what waits for an agent changes nothing for the agent (#7727, Security's #7757 read): the page lists its unread board messages, and they stay unread.
func TestListingWhatWaitsForAnAgentLeavesItsMessagesUnread(t *testing.T) {
	waitingLookLeavesUnread(t, "mentions", []string{"@Worker first", "@Worker second"})
}

// The same for an agent that gets every message (receive mode all): the page lists them, as many as it counts as unread, and still leaves them unread.
func TestListingWhatWaitsForAnAgentThatReadsEverythingListsAndLeavesItsMessages(t *testing.T) {
	waitingLookLeavesUnread(t, "all", []string{"first, tagging nobody", "second, tagging nobody"})
}

func waitingLookLeavesUnread(t *testing.T, mode string, texts []string) {
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
	require.Equal(t, 2, unread())
	for i := 0; i < 2; i++ { // twice: the second look must show what the first did
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/waiting?agent_type=claude&session_id=" + sid)
		require.NoError(t, err)
		var out struct {
			Unread   int              `json:"unread"`
			Messages []map[string]any `json:"messages"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, 2, out.Unread, "look %d", i)
		assert.Len(t, out.Messages, 2, "look %d lists both messages", i)
		assert.Equal(t, 2, unread(), "look %d: the agent still has both unread", i)
	}
}
