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

// #10362 (critical): a person who picks Default in New agent, or presses Keep Default in "Default mode waits for you", gets a Default agent, never the saved default (Auto) or Claude's own Auto. The launch says
// so with permission_mode "default" (the form sends no flag for Default, which the server could not tell from "nothing chosen"); no other mode can be named this way.
func TestAnExplicitDefaultModeIsNeverWidenedToTheSavedDefaultOrAuto(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fakeClaude := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(fakeClaude, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fakeClaude))
	post := func(body map[string]any) *httptest.ResponseRecorder {
		body["working_dir"] = rig.workdir
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
		return rec
	}
	launch := func(body map[string]any) (cmd, stored string) {
		t.Helper()
		rec := post(body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		ls, err := rig.ss.GetLiveSession(ctx, res["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls)
		if ls.PermissionMode != nil {
			stored = *ls.PermissionMode
		}
		rig.term.mu.Lock()
		defer rig.term.mu.Unlock()
		var sent []string
		for name, cmds := range rig.term.sent {
			if strings.Contains(name, res["session_id"].(string)) {
				sent = cmds
			}
		}
		require.NotEmpty(t, sent)
		return sent[len(sent)-1], stored
	}

	for _, saved := range []string{"auto", "bypassPermissions", ""} { // the saved default, and none (Claude's own Auto)
		if saved != "" {
			require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", saved))
		}
		cmd, stored := launch(map[string]any{"agent_type": at.Claude, "permission_mode": "default"})
		assert.Contains(t, cmd, "--permission-mode default", "saved default %q: Default is Default", saved)
		assert.NotContains(t, cmd, "--permission-mode auto")
		assert.NotContains(t, cmd, "dangerously-skip-permissions")
		assert.Equal(t, "default", stored, "saved default %q: what is recorded for a restart", saved)
	}

	// the field names Default and nothing else: any other mode is refused, with nothing launched
	for _, mode := range []string{"auto", "bypassPermissions", "plan", "acceptEdits", "dontAsk", "nonsense"} {
		rec := post(map[string]any{"agent_type": at.Claude, "permission_mode": mode})
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", mode, rec.Body.String())
	}
	// the person's own flags still win over it, as over every mode
	cmd, stored := launch(map[string]any{"agent_type": at.Claude, "permission_mode": "default", "flags": []string{"--permission-mode", "plan"}})
	assert.Contains(t, cmd, "--permission-mode plan")
	assert.Equal(t, "plan", stored)
}

// #10362: the same for a team member. A member who picked Default is a Default agent, whatever mode is saved; a member with nothing chosen still gets the saved default; the field names Default and nothing else.
func TestATeamMemberWhoPickedDefaultStartsInDefaultWhateverIsSaved(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	team := func(member map[string]any) (int, string) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"board_name": "t" + strings.ReplaceAll(t.Name(), "/", "") + member["name"].(string), "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude,
			"agents": []map[string]any{member}})
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b)))
		if rec.Code != http.StatusOK {
			return rec.Code, rec.Body.String()
		}
		var res struct {
			Agents []map[string]any `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		require.Len(t, res.Agents, 1, rec.Body.String())
		ls, err := ss.GetLiveSession(ctx, res.Agents[0]["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls.PermissionMode)
		return rec.Code, *ls.PermissionMode
	}
	_, nothing := team(map[string]any{"name": "N", "agent_type": "claude"})
	assert.Equal(t, "auto", nothing, "a member with nothing chosen gets the saved default, as before")
	_, picked := team(map[string]any{"name": "D", "agent_type": "claude", "permission_mode": "default"})
	assert.Equal(t, "default", picked, "a member who picked Default is Default")
	_, own := team(map[string]any{"name": "P", "agent_type": "claude", "permission_mode": "default", "flags": []string{"--permission-mode", "plan"}})
	assert.Equal(t, "plan", own, "the member's own flags still win")
	for _, mode := range []string{"auto", "bypassPermissions", "plan"} {
		code, body := team(map[string]any{"name": "X" + mode, "agent_type": "claude", "permission_mode": mode})
		assert.Equal(t, http.StatusBadRequest, code, "%s: %s", mode, body)
	}
}
