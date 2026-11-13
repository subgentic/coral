package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// The UI's named member mode must win over the team's broader Auto flags (#16388).
func TestTeamMemberCustomModeOverridesTeamAuto(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "Edits ok", Flags: []string{"--permission-mode", "acceptEdits"}}}, 1))
	body, _ := json.Marshal(map[string]any{"board_name": "custom-member", "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude", "flags": []string{"--permission-mode", "auto"}, "agents": []map[string]any{{"name": "QA Engineer", "permission_mode": "custom:aaaaaaaaaaaaaaaa"}}})
	rec := httptest.NewRecorder()
	h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cmd := lastSentCommand(term)
	require.Contains(t, cmd, "--permission-mode acceptEdits")
	require.NotContains(t, cmd, "--permission-mode auto")
	require.Contains(t, rec.Body.String(), "custom:aaaaaaaaaaaaaaaa")
}
