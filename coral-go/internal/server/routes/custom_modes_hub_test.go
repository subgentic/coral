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

	"github.com/subgentic/coral/internal/store"
)

// #15950 (Security's MUST): a custom permission mode is judged by the flags it adds, on every Coral Hub path. A team member in a mode that turns the prompts off needs the owner's auto-accept
// switch like any other member that skips them; a mode that cannot be resolved counts as skipping (the gate fails closed); a mode that keeps the prompts starts.
func TestHubTeamLaunchJudgesACustomModeByItsFlags(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, "launch"))
	require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "false")) // the owner has not allowed auto-accept through the Hub
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{
		{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "open", Flags: []string{"--dangerously-skip-permissions"}},
		{ID: "bbbbbbbbbbbbbbbb", AgentType: "claude", Name: "asks", Flags: []string{"--permission-mode", "default"}},
		{ID: "cccccccccccccccc", AgentType: "codex", Name: "codex open", Flags: []string{"-a", "never"}},
	}, 1))
	launch := func(board, mode string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude",
			"agents": []map[string]any{{"name": "A", "permission_mode": mode}}})
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, stamp(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body))))
		return rec
	}
	for _, tc := range []struct {
		name, mode string
		refused    bool
	}{
		{"a mode that turns the prompts off", "custom:aaaaaaaaaaaaaaaa", true},
		{"a mode of another agent type", "custom:cccccccccccccccc", true},
		{"a mode that is gone", "custom:dddddddddddddddd", true},
		{"a mode that only narrows", "custom:bbbbbbbbbbbbbbbb", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := launch("hubcm-"+tc.name[2:5], tc.mode)
			if !tc.refused {
				assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				assert.NotContains(t, rec.Body.String(), "hub_auto_accept_disabled")
				return
			}
			assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "hub_auto_accept_disabled", "the member is held to the owner's switch")
		})
	}
}

// The owner turns the switch off after the first member started: the member's own turn re-reads the settings (#5839), and a custom mode that turns the prompts off is stopped there too.
func TestHubTeamLaunchChecksACustomModeMemberWhenItsTurnComes(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, "launch"))
	require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "true"))
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "open", Flags: []string{"--dangerously-skip-permissions"}}}, 1))
	started := 0
	term.mu.Lock()
	term.onCall = func(method string) {
		if method != "CreateSession" {
			return
		}
		started++
		if started == 1 {
			require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "false"))
		}
	}
	term.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"board_name": "hubcm-turn", "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude",
		"agents": []map[string]any{{"name": "A", "permission_mode": "custom:aaaaaaaaaaaaaaaa"}, {"name": "B", "permission_mode": "custom:aaaaaaaaaaaaaaaa"}}})
	rec := httptest.NewRecorder()
	h.LaunchTeam(rec, stamp(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body))))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Agents []map[string]any `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Agents, 2, rec.Body.String())
	byName := map[string]map[string]any{}
	for _, a := range out.Agents {
		byName[a["name"].(string)] = a
	}
	assert.NotContains(t, byName["A"], "error", "the first member started before the switch changed")
	assert.Equal(t, "hub_auto_accept_disabled", byName["B"]["code"], "the second member's custom mode turns the prompts off: %v", byName["B"])
	assert.NotContains(t, byName["B"], "session_id")
}

// Security's SHOULD on #15950: which rule a restart through the Hub meets. Today it gates what the restart ADDS (extra flags, capabilities, Full access), not what the agent already runs: an
// agent stored in a bypass mode restarts with it, whichever way the mode was stored. The test says that for a custom bypass mode and a built-in one together, so neither can drift from the other,
// and that a bypass added by the restart itself is held to the owner's switch.
func TestHubRestartOfAnAgentInABypassModeMeetsTheSameRuleCustomOrBuiltIn(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, "launch"))
	require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "false"))
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "open", Flags: []string{"--dangerously-skip-permissions"}}}, 1))
	n := 0
	restart := func(stored store.LiveSession, extra string) *httptest.ResponseRecorder {
		n++
		stored.SessionID = "hub-cm-restart-" + string(rune('a'+n))
		stored.AgentType, stored.AgentName, stored.WorkingDir = "claude", "coral-go", t.TempDir()
		require.NoError(t, ss.RegisterLiveSession(ctx, &stored))
		name := "claude-" + stored.SessionID
		term.addSession(name, t.TempDir())
		b, _ := json.Marshal(map[string]any{"session_id": stored.SessionID, "agent_type": "claude", "extra_flags": extra})
		req := dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(b)), map[string]string{"name": name})
		rec := httptest.NewRecorder()
		h.Restart(rec, stamp(req))
		return rec
	}
	custom, builtIn := "custom:aaaaaaaaaaaaaaaa", store.MarshalFlags([]string{"--dangerously-skip-permissions"})
	assert.Equal(t, http.StatusOK, restart(store.LiveSession{PermissionMode: &custom}, "").Code, "a stored custom bypass mode restarts with it, as a stored built-in one does")
	assert.Equal(t, http.StatusOK, restart(store.LiveSession{Flags: builtIn}, "").Code, "a stored built-in bypass restarts with it")
	rec := restart(store.LiveSession{PermissionMode: &custom}, "--dangerously-skip-permissions")
	assert.Equal(t, http.StatusForbidden, rec.Code, "a bypass the restart itself adds is held to the owner's switch: %s", rec.Body.String())
	assert.Equal(t, "hub_auto_accept_disabled", codeOf(t, rec))
}
