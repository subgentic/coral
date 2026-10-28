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

// #10380: a stopped team's member who picked Default is resurrected in Default, whatever is saved: the resurrect named no mode, so it fell to the saved default (Auto).
func TestAResurrectedMemberWhoPickedDefaultStaysInDefault(t *testing.T) {
	url, _, h := teamServerH(t)
	ctx := context.Background()
	require.NoError(t, h.ss.SetSetting(ctx, "default_permission_mode", "auto"))
	b, _ := json.Marshal(map[string]any{"board_name": "resdefault", "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude,
		"agents": []map[string]any{{"name": "D", "agent_type": "claude", "permission_mode": "default"}, {"name": "N", "agent_type": "claude"}}})
	resp, err := http.Post(url+"/api/sessions/launch-team", "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var launched struct {
		BoardID string `json:"board_id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&launched))
	require.NotEmpty(t, launched.BoardID)
	status, body := apiPost(t, url+"/api/sessions/live/team/"+launched.BoardID+"/kill")
	require.Equal(t, http.StatusOK, status, body)

	status, body = apiPost(t, url+"/api/teams/detail/"+launched.BoardID+"/resurrect")
	require.Equal(t, http.StatusOK, status, body)
	var res struct {
		Agents []map[string]any `json:"agents"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &res), body)
	modes := map[string]string{}
	for _, a := range res.Agents {
		id, _ := a["session_id"].(string)
		require.NotEmpty(t, id, body)
		ls, err := h.ss.GetLiveSession(ctx, id)
		require.NoError(t, err)
		require.NotNil(t, ls)
		require.NotNil(t, ls.PermissionMode)
		modes[a["name"].(string)] = *ls.PermissionMode
	}
	assert.Equal(t, "default", modes["D"], "the member who picked Default: %s", body)
	assert.Equal(t, "auto", modes["N"], "a member with nothing chosen still gets the saved default")
}

// #10430 (Security, safety): a team launched in Plan or Accept edits, killed and resurrected, came back in the saved default (Auto): the member was stored without the mode it started in.
// Each member comes back in the mode it had, never a wider one, with Auto saved; a member with permission flags of its own keeps them.
func TestAResurrectedMemberKeepsTheModeItStartedIn(t *testing.T) {
	url, _, h := teamServerH(t)
	ctx := context.Background()
	require.NoError(t, h.ss.SetSetting(ctx, "default_permission_mode", "auto"))
	for _, tc := range []struct {
		name      string
		teamFlags []string
		member    map[string]any
		want      string
	}{
		{"plan", []string{"--permission-mode", "plan"}, map[string]any{"name": "A", "agent_type": "claude"}, "plan"},
		{"acceptedits", []string{"--permission-mode", "acceptEdits"}, map[string]any{"name": "A", "agent_type": "claude"}, "acceptEdits"},
		{"ownflags", nil, map[string]any{"name": "A", "agent_type": "claude", "flags": []string{"--permission-mode", "plan"}}, "plan"},
		{"default", nil, map[string]any{"name": "A", "agent_type": "claude", "permission_mode": "default"}, "default"},
		{"nothing", nil, map[string]any{"name": "A", "agent_type": "claude"}, "auto"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			board := "resmode" + tc.name
			b, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude, "flags": tc.teamFlags, "agents": []map[string]any{tc.member}})
			resp, err := http.Post(url+"/api/sessions/launch-team", "application/json", bytes.NewReader(b))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var launched struct {
				BoardID string `json:"board_id"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&launched))
			status, body := apiPost(t, url+"/api/sessions/live/team/"+launched.BoardID+"/kill")
			require.Equal(t, http.StatusOK, status, body)

			status, body = apiPost(t, url+"/api/teams/detail/"+launched.BoardID+"/resurrect")
			require.Equal(t, http.StatusOK, status, body)
			var res struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal([]byte(body), &res), body)
			require.Len(t, res.Agents, 1, body)
			id, _ := res.Agents[0]["session_id"].(string)
			require.NotEmpty(t, id, body)
			ls, err := h.ss.GetLiveSession(ctx, id)
			require.NoError(t, err)
			require.NotNil(t, ls)
			require.NotNil(t, ls.PermissionMode)
			assert.Equal(t, tc.want, *ls.PermissionMode, "the resurrected member's mode")
		})
	}
}

// #10454 (Security Reviewer Windows, on #10430): a member stored before #10430 has no mode in its config. It comes back in the mode its previous session recorded (a team launched in Plan stays in
// Plan), and only when that session recorded none, in the saved default. The stored config here is stripped of the mode and flags, as the older launch-team wrote it.
func TestAMemberStoredBeforeTheModeWasKeptComesBackInItsPreviousSessionsMode(t *testing.T) {
	url, _, h := teamServerH(t)
	ctx := context.Background()
	require.NoError(t, h.ss.SetSetting(ctx, "default_permission_mode", "auto"))
	for _, tc := range []struct {
		name       string
		teamFlags  []string
		forgetPrev bool // the previous session's row is gone
		want       string
	}{
		{"plan", []string{"--permission-mode", "plan"}, false, "plan"},
		{"acceptedits", []string{"--permission-mode", "acceptEdits"}, false, "acceptEdits"},
		{"nothing recorded", []string{"--permission-mode", "plan"}, true, "auto"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			board := "legacy" + strings.ReplaceAll(tc.name, " ", "")
			b, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude, "flags": tc.teamFlags, "agents": []map[string]any{{"name": "A", "agent_type": "claude"}}})
			resp, err := http.Post(url+"/api/sessions/launch-team", "application/json", bytes.NewReader(b))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var launched struct {
				BoardID string           `json:"board_id"`
				Agents  []map[string]any `json:"agents"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&launched))
			require.Len(t, launched.Agents, 1)
			prev, _ := launched.Agents[0]["session_id"].(string)
			ls, err := h.ss.GetLiveSession(ctx, prev)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode, "the previous session recorded its mode")

			// the member as the older launch-team stored it: no mode, no flags
			_, err = h.db.ExecContext(ctx, `UPDATE team_members SET agent_config_json = json_remove(agent_config_json, '$.permission_mode', '$.flags')`)
			require.NoError(t, err)
			if tc.forgetPrev {
				_, err = h.db.ExecContext(ctx, `UPDATE live_sessions SET permission_mode = NULL WHERE session_id = ?`, prev)
				require.NoError(t, err)
			}
			status, body := apiPost(t, url+"/api/sessions/live/team/"+launched.BoardID+"/kill")
			require.Equal(t, http.StatusOK, status, body)
			status, body = apiPost(t, url+"/api/teams/detail/"+launched.BoardID+"/resurrect")
			require.Equal(t, http.StatusOK, status, body)
			var res struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal([]byte(body), &res), body)
			require.Len(t, res.Agents, 1, body)
			id, _ := res.Agents[0]["session_id"].(string)
			require.NotEmpty(t, id, body)
			now, err := h.ss.GetLiveSession(ctx, id)
			require.NoError(t, err)
			require.NotNil(t, now.PermissionMode)
			assert.Equal(t, tc.want, *now.PermissionMode, "the resurrected member's mode")
		})
	}
}
