package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #10487 (SAFETY, #10454's report: team reset had no test of its own for the mode): a team reset relaunches each member in the mode it had, never in the saved default (Auto): a team launched in Plan or
// Accept edits comes back in it, a member who picked Default comes back in Default, a member with nothing chosen in the saved default as before. What is recorded is what the reset restores.
func TestATeamResetKeepsEachMembersMode(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	for _, tc := range []struct {
		name      string
		teamFlags []string
		member    map[string]any
		want      string
	}{
		{"plan", []string{"--permission-mode", "plan"}, map[string]any{"name": "A"}, "plan"},
		{"accept edits", []string{"--permission-mode", "acceptEdits"}, map[string]any{"name": "A"}, "acceptEdits"},
		{"default picked", nil, map[string]any{"name": "A", "permission_mode": "default"}, "default"},
		{"own flags", nil, map[string]any{"name": "A", "flags": []string{"--permission-mode", "plan"}}, "plan"},
		{"nothing chosen", nil, map[string]any{"name": "A"}, "auto"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			board := "resetmode" + string(rune('a'+len(tc.name)))
			agents := []map[string]any{tc.member}
			agents[0]["agent_type"] = "claude"
			body, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude, "flags": tc.teamFlags, "agents": agents})
			rec := httptest.NewRecorder()
			h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var launched struct {
				Board  string           `json:"board"`
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &launched))
			require.Len(t, launched.Agents, 1, rec.Body.String())
			first, _ := launched.Agents[0]["session_id"].(string)
			ls, err := ss.GetLiveSession(ctx, first)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode)
			assert.Equal(t, tc.want, *ls.PermissionMode, "launched in")

			rr := httptest.NewRecorder()
			h.ResetTeam(rr, dropAt2(httptest.NewRequest(http.MethodPost, "/reset", nil), map[string]string{"boardName": launched.Board}))
			require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
			var reset struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &reset), rr.Body.String())
			require.Len(t, reset.Agents, 1, rr.Body.String())
			again, _ := reset.Agents[0]["session_id"].(string)
			require.NotEmpty(t, again, rr.Body.String())
			require.NotEqual(t, first, again, "a new session")
			now, err := ss.GetLiveSession(ctx, again)
			require.NoError(t, err)
			require.NotNil(t, now.PermissionMode)
			assert.Equal(t, tc.want, *now.PermissionMode, "after the reset")
		})
	}
}
