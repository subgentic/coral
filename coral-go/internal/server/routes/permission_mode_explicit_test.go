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
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #5894: Claude Code 2.1.283 and later starts an interactive session in Auto when no --permission-mode is given. Everywhere Coral means "ask" (a Coral Hub launch with the switch off,
// an agent started by another agent, a saved default of "default", a restart restoring one) the command Claude is started with says --permission-mode default, never nothing; a launch that
// means Auto says --permission-mode auto.
func TestEveryClaudeLaunchThatMeansAskCarriesAnExplicitDefaultMode(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, "launch"))
	require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "false")) // the owner's switch is off
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "claude", AgentName: "parent", WorkingDir: t.TempDir()}))
	asAgent := func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "claude-" + parent}))
	}
	last := func() string {
		cmds := term.sentCommands()
		require.NotEmpty(t, cmds)
		return cmds[len(cmds)-1]
	}
	mustAsk := func(why string) {
		t.Helper()
		cmd := last()
		assert.Contains(t, cmd, "--permission-mode default", why)
		assert.NotContains(t, cmd, "--permission-mode auto", why)
		assert.NotContains(t, cmd, "dangerously-skip-permissions", why)
	}
	launch := func(req func(*http.Request) *http.Request) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"agent_type": at.Claude, "working_dir": t.TempDir()})
		rec := httptest.NewRecorder()
		h.Launch(rec, req(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	team := func(name string, req func(*http.Request) *http.Request) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"board_name": "ask-" + name, "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude,
			"agents": []map[string]any{{"name": "A", "agent_type": "claude"}}})
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, req(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}

	launch(stamp)
	mustAsk("the Hub fallback, switch off")
	team("hub", stamp)
	mustAsk("a Hub team member, switch off")
	launch(asAgent)
	mustAsk("an agent-launched agent")
	team("agent", asAgent)
	mustAsk("a team member an agent launches")

	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "default"))
	launch(func(r *http.Request) *http.Request { return r })
	mustAsk("a saved default of default, from the dashboard")

	// a restart restoring a stored default
	const restarted = "22222222-3333-4444-8555-666666666666"
	mode := "default"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: restarted, AgentType: "claude", AgentName: "coral-go", WorkingDir: t.TempDir(), PermissionMode: &mode}))
	name := "claude-" + restarted
	term.addSession(name, t.TempDir())
	rb, _ := json.Marshal(map[string]any{"session_id": restarted, "agent_type": "claude"})
	rec := httptest.NewRecorder()
	h.Restart(rec, dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(rb)), map[string]string{"name": name}))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	mustAsk("a restart restoring the stored default")

}

// A launch that means Auto still says --permission-mode auto (the owner's switch on, Launch), and not default.
func TestAClaudeLaunchThatMeansAutoSaysSo(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, "launch"))
	require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, "true"))
	b, _ := json.Marshal(map[string]any{"agent_type": at.Claude, "working_dir": t.TempDir()})
	rec := httptest.NewRecorder()
	h.Launch(rec, stamp(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cmds := term.sentCommands()
	require.NotEmpty(t, cmds)
	assert.Contains(t, cmds[len(cmds)-1], "--permission-mode auto")
	assert.NotContains(t, cmds[len(cmds)-1], "--permission-mode default")
}

// #10380: a restart of an agent that is in Default keeps Default when the saved default is Auto: the stored mode is what a restart restores, never the saved default.
func TestARestartOfADefaultAgentStaysDefaultWhenAutoIsSaved(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	const restarted = "33333333-4444-4555-8666-777777777777"
	mode := "default"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: restarted, AgentType: "claude", AgentName: "coral-go", WorkingDir: t.TempDir(), PermissionMode: &mode}))
	name := "claude-" + restarted
	term.addSession(name, t.TempDir())
	rb, _ := json.Marshal(map[string]any{"session_id": restarted, "agent_type": "claude"})
	rec := httptest.NewRecorder()
	h.Restart(rec, dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(rb)), map[string]string{"name": name}))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cmds := term.sentCommands()
	require.NotEmpty(t, cmds)
	cmd := cmds[len(cmds)-1]
	assert.Contains(t, cmd, "--permission-mode default")
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.NotContains(t, cmd, "dangerously-skip-permissions")
}

// #10297 (Security, safety): Restart with the same settings sends no mode. An agent from before modes were recorded (no stored mode, no permission flags) restarts in Default, never the saved Auto, and the
// answer says so; a stored mode, and permission flags of its own, are kept as they were.
func TestARestartOfAnAgentWithNoRecordedModeIsInDefaultAndSaysSo(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		sid, name string
		mode      *string
		flags     []string
		want      string
		note      bool
	}{
		{"00000000-0000-0000-0000-000000d00001", "default-stored", str("default"), nil, "default", false},
		{"00000000-0000-0000-0000-000000d00002", "plan-stored", str("plan"), nil, "plan", false},
		{"00000000-0000-0000-0000-000000d00003", "legacy-none", nil, nil, "default", true},
		{"00000000-0000-0000-0000-000000d00004", "plan-flags-only", nil, []string{"--permission-mode", "plan"}, "plan", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			sn := naming.SessionName("claude", c.sid)
			require.NoError(t, term.CreateSession(ctx, sn, t.TempDir()))
			ls := &store.LiveSession{SessionID: c.sid, AgentType: "claude", AgentName: c.name, WorkingDir: t.TempDir(), PermissionMode: c.mode}
			if c.flags != nil {
				ls.Flags = store.MarshalFlags(c.flags)
			}
			require.NoError(t, ss.RegisterLiveSession(ctx, ls))
			body, _ := json.Marshal(map[string]any{"session_id": c.sid, "agent_type": "claude"})
			resp, err := http.Post(server.URL+"/api/sessions/live/"+sn+"/restart", "application/json", bytes.NewReader(body))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var res map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
			if c.note {
				assert.Equal(t, "Its mode was not recorded: restarted in Default", res["mode_note"])
			} else {
				assert.Nil(t, res["mode_note"])
			}
			nl, err := ss.GetLiveSession(ctx, res["session_id"].(string))
			require.NoError(t, err)
			require.NotNil(t, nl)
			require.NotNil(t, nl.PermissionMode)
			assert.Equal(t, c.want, *nl.PermissionMode)
		})
	}
}
