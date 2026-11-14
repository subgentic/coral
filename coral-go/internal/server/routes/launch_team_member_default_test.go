package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #16583 (walk 25): a team member whose own mode is Default must start in Default, never in the mode the team's flags carry. The wizard sends the team's mode as flags (--permission-mode auto) and a member
// that picked Default as permission_mode "default" with no flags of its own; the launch appended the team's flags to that member, so it ran --permission-mode auto: more access than was chosen.
func TestATeamMemberWhoPickedDefaultIsNotWidenedByTheTeamsMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fakeClaude := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(fakeClaude, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fakeClaude))
	for _, teamMode := range []string{"auto", "plan", "acceptEdits"} {
		body, _ := json.Marshal(map[string]any{"board_name": "t16583" + teamMode, "new_board": true, "working_dir": rig.workdir, "agent_type": at.Claude,
			"flags": []string{"--permission-mode", teamMode},
			"agents": []map[string]any{
				{"name": "Dflt", "agent_type": "claude", "permission_mode": "default"}, // the member's own mode is Default
				{"name": "Inherits", "agent_type": "claude"},                           // nothing chosen: follows the team
				{"name": "Own", "agent_type": "claude", "flags": []string{"--permission-mode", "plan"}},
			}})
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res struct {
			Agents []map[string]any `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		require.Len(t, res.Agents, 3, rec.Body.String())
		cmdOf := func(i int) (cmd, stored string) {
			id := res.Agents[i]["session_id"].(string)
			ls, err := rig.ss.GetLiveSession(ctx, id)
			require.NoError(t, err)
			require.NotNil(t, ls)
			if ls.PermissionMode != nil {
				stored = *ls.PermissionMode
			}
			rig.term.mu.Lock()
			defer rig.term.mu.Unlock()
			for name, cmds := range rig.term.sent {
				if strings.Contains(name, id) && len(cmds) > 0 {
					cmd = cmds[len(cmds)-1]
				}
			}
			require.NotEmpty(t, cmd, "the member's launch command")
			return cmd, stored
		}
		cmd, stored := cmdOf(0)
		assert.Contains(t, cmd, "--permission-mode default", "team %s: a member who picked Default starts in Default", teamMode)
		assert.NotContains(t, cmd, "--permission-mode "+teamMode, "team %s: and not in the team's mode", teamMode)
		assert.Equal(t, "default", stored, "team %s: and is recorded as Default", teamMode)
		cmd, stored = cmdOf(1)
		assert.Contains(t, cmd, "--permission-mode "+teamMode, "team %s: a member with nothing chosen follows the team", teamMode)
		assert.Equal(t, teamMode, stored)
		cmd, stored = cmdOf(2)
		assert.Contains(t, cmd, "--permission-mode plan", "team %s: a member's own flags still win", teamMode)
		assert.Equal(t, "plan", stored)
	}
}
