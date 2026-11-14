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

// A member's custom mode is kept by a restart and by a team reset: the command carries acceptEdits, never the team's Auto (#16420, #16388).
func TestTeamMemberCustomModeSurvivesRestartAndReset(t *testing.T) {
	srv, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "Edits ok", Flags: []string{"--permission-mode", "acceptEdits"}}}, 1))
	body, _ := json.Marshal(map[string]any{"board_name": "custom-restart", "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude", "flags": []string{"--permission-mode", "auto"}, "agents": []map[string]any{{"name": "QA Engineer", "permission_mode": "custom:aaaaaaaaaaaaaaaa"}}})
	rec := httptest.NewRecorder()
	h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var launched struct {
		Board  string           `json:"board"`
		Agents []map[string]any `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &launched))
	require.Len(t, launched.Agents, 1, rec.Body.String())
	sid, _ := launched.Agents[0]["session_id"].(string)
	name, _ := launched.Agents[0]["session_name"].(string)
	require.NotEmpty(t, sid)
	require.Contains(t, lastSentCommand(term), "--permission-mode acceptEdits", "the launch itself")

	rb, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": "claude"})
	resp, err := http.Post(srv.URL+"/api/sessions/live/"+name+"/restart", "application/json", bytes.NewReader(rb))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cmd := lastSentCommand(term)
	require.Contains(t, cmd, "--permission-mode acceptEdits", "after a restart")
	require.NotContains(t, cmd, "--permission-mode auto", "after a restart")

	rs := httptest.NewRecorder()
	h.ResetTeam(rs, dropAt2(httptest.NewRequest(http.MethodPost, "/reset", nil), map[string]string{"boardName": launched.Board}))
	require.Equal(t, http.StatusOK, rs.Code, rs.Body.String())
	cmd = lastSentCommand(term)
	require.Contains(t, cmd, "--permission-mode acceptEdits", "after a team reset")
	require.NotContains(t, cmd, "--permission-mode auto", "after a team reset")
}
