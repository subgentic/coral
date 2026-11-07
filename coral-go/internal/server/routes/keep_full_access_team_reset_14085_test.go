package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A team reset starts every member again as a NEW session, so the Operator's keep-Full-access choice (#14061, #14085) must go with the member who has it: that member's launch is Full access, the
// choice is on its new session and gone from the old one, and a member without it is reset as before.
func TestATeamResetCarriesTheKeepFullAccessChoiceToTheNewSession(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	body, _ := json.Marshal(map[string]any{"board_name": "reset-keep", "working_dir": t.TempDir(), "agent_type": "codex", "backend": "tmux", "flags": []string{"--permission-mode=plan"},
		"agents": []map[string]any{{"name": "Keeper", "prompt": ""}, {"name": "Plain", "prompt": ""}}})
	rec := httptest.NewRecorder()
	h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var launched struct {
		Board string `json:"board"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &launched))

	live, err := ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	var keeperOld string
	for _, s := range live {
		if s.DisplayName != nil && *s.DisplayName == "Keeper" {
			keeperOld = s.SessionID
		}
	}
	require.NotEmpty(t, keeperOld)
	_, err = ss.SetKeepFullAccess(ctx, keeperOld, true)
	require.NoError(t, err)

	rr := httptest.NewRecorder()
	h.ResetTeam(rr, dropAt2(httptest.NewRequest(http.MethodPost, "/reset", nil), map[string]string{"boardName": launched.Board}))
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var reset struct {
		Agents []struct {
			Name        string `json:"name"`
			SessionID   string `json:"session_id"`
			SessionName string `json:"session_name"`
		} `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &reset))
	require.Len(t, reset.Agents, 2)
	for _, a := range reset.Agents {
		cmd := strings.Join(term.sentToSession(a.SessionName), "\n")
		on, err := ss.KeepFullAccess(ctx, a.SessionID)
		require.NoError(t, err)
		if strings.HasPrefix(a.Name, "Keeper") {
			require.Contains(t, cmd, "--dangerously-bypass-approvals-and-sandbox", "the member with the choice is reset with Full access")
			require.NotContains(t, cmd, "read-only")
			require.True(t, on, "the choice is on the new session")
		} else {
			require.NotContains(t, cmd, "--dangerously-bypass-approvals-and-sandbox", "the other member is reset as before")
			require.False(t, on)
		}
	}
	old, err := ss.KeepFullAccess(ctx, keeperOld)
	require.NoError(t, err)
	require.False(t, old, "and gone from the old session")
}
