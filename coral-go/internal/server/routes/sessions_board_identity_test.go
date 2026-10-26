package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// The dock's scope uses the board membership, even when display/job titles imply the opposite role.
func TestLiveListCarriesStableBoardMemberAndOrchestratorFlag(t *testing.T) {
	server, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	for _, c := range []struct {
		sid, member, title, display string
		orch                        bool
	}{
		{"11111111-2222-4333-8444-555555555555", "worker-id", "Backend", "Orchestrator", false},
		{"22222222-2222-4333-8444-555555555555", "lead-id", "Coordinator", "Coordinator", true},
	} {
		name := naming.SessionName("claude", c.sid)
		dir := t.TempDir()
		term.addSession(name, dir)
		display := c.display
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: c.sid, AgentType: "claude", AgentName: c.member, WorkingDir: dir, DisplayName: &display}))
		_, err := h.bs.Subscribe(ctx, "identity-team", c.member, c.title, name, nil, "mentions", c.orch)
		require.NoError(t, err)
	}
	for _, sleeping := range []bool{false, true} {
		if sleeping {
			for _, sid := range []string{"11111111-2222-4333-8444-555555555555", "22222222-2222-4333-8444-555555555555"} {
				require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
				term.mu.Lock()
				delete(term.sessions, naming.SessionName("claude", sid))
				term.mu.Unlock()
			}
		}
		resp, err := http.Get(server.URL + "/api/sessions/live")
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var rows []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
		require.Len(t, rows, 2)
		for _, row := range rows {
			if row["session_id"] == "11111111-2222-4333-8444-555555555555" {
				require.Equal(t, "worker-id", row["board_subscriber_id"])
				require.Equal(t, false, row["board_is_orchestrator"])
			} else {
				require.Equal(t, "lead-id", row["board_subscriber_id"])
				require.Equal(t, true, row["board_is_orchestrator"])
			}
		}
	}
}
