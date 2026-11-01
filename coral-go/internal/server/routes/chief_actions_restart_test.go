package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #11798: the Operator's chief_actions setting ("ask_first", the default, or "act") is the permission mode the recorded Chief restarts in: ask_first is Default, act is Accept edits and never Bypass
// Permissions (a shell command still asks). It is Chief's alone: another agent, and Chief while the page is off, restart as they were.
func TestARestartOfChiefFollowsTheChiefActionsSetting(t *testing.T) {
	const chief = "00000000-0000-0000-0000-00000000c001"
	const other = "00000000-0000-0000-0000-00000000c002"
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		name, actions, page string
		sid, stored         string
		want                string
		recorded            bool // chief_session follows the restarted agent
	}{
		{"unset is ask first", "", "true", chief, "default", "default", true},
		{"ask first lowers an agent that was in act", "ask_first", "true", chief, "acceptEdits", "default", true},
		{"act is accept edits", "act", "true", chief, "default", "acceptEdits", true},
		{"act is never more than accept edits", "act", "true", chief, "bypassPermissions", "acceptEdits", true},
		{"another agent is unchanged by act", "act", "true", other, "default", "default", false},
		{"another agent is unchanged by ask first", "ask_first", "true", other, "plan", "plan", false},
		{"chief while the page is off is unchanged", "act", "false", chief, "plan", "plan", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			server, _, term, ss := setupSessionsTestServer(t)
			defer server.Close()
			stubCLIPaths(t, ss)
			ctx := context.Background()
			require.NoError(t, ss.SetSetting(ctx, "chief_page", c.page))
			require.NoError(t, ss.SetSetting(ctx, "chief_session", chief))
			require.NoError(t, ss.SetSetting(ctx, "chief_team", "chief"))
			if c.actions != "" {
				require.NoError(t, ss.SetSetting(ctx, "chief_actions", c.actions))
			}
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: c.sid, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), PermissionMode: str(c.stored)}))
			sn := naming.SessionName("claude", c.sid)
			require.NoError(t, term.CreateSession(ctx, sn, t.TempDir()))
			body, _ := json.Marshal(map[string]any{"session_id": c.sid, "agent_type": "claude"})
			resp, err := http.Post(server.URL+"/api/sessions/live/"+sn+"/restart", "application/json", bytes.NewReader(body))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var res map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
			newID := res["session_id"].(string)
			nl, err := ss.GetLiveSession(ctx, newID)
			require.NoError(t, err)
			require.NotNil(t, nl)
			require.NotNil(t, nl.PermissionMode)
			assert.Equal(t, c.want, *nl.PermissionMode, "the mode recorded for the restarted agent")
			cmds := term.sentCommands()
			require.NotEmpty(t, cmds)
			cmd := cmds[len(cmds)-1]
			assert.Contains(t, cmd, "--permission-mode "+c.want)
			assert.NotContains(t, cmd, "dangerously-skip-permissions")
			st, err := ss.GetSettings(ctx)
			require.NoError(t, err)
			if c.recorded {
				assert.Equal(t, newID, st["chief_session"], "Chief is still the recorded agent after its restart")
			} else {
				assert.Equal(t, chief, st["chief_session"], "a restart of anyone else leaves the record alone")
			}
		})
	}
}
