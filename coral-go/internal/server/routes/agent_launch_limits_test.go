package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

var bypassFlags = []string{"--dangerously-skip-permissions", "--yolo=true", "--allowedTools", "Bash(*)", "--settings", "/tmp/x.json", "--verbose"}

// #4032 (Security's #4031 finding 1): an agent's token starts an agent without the permission
// flags, allowed tools or settings it asks for, on a single launch and a team launch; the
// Operator's launch keeps them.
func TestAgentCannotLaunchALessRestrictedAgent(t *testing.T) {
	bypass := "bypassPermissions"
	for _, tc := range []struct {
		name       string
		asAgent    bool
		callerMode *string // the launching agent's stored mode (nil: the row records none, rank 0)
		wantStart  bool
		wantKept   bool // the Operator's flags are kept as asked
	}{
		{"operator", false, nil, true, true},
		{"agent whose row records no mode", true, nil, false, false},
		{"agent in bypass", true, &bypass, true, false},
	} {
		for _, team := range []bool{false, true} {
			cfg := &config.Config{LogDir: t.TempDir()}
			db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
			require.NoError(t, err)
			t.Cleanup(func() { db.Close() })
			stubCLIPaths(t, store.NewSessionStore(db))
			terminal := newMockTerminal()
			h := NewSessionsHandler(db, cfg, nil, terminal, nil)
			work := t.TempDir() // an agent starts agents in its team's folder (#13891)
			require.NoError(t, store.NewSessionStore(db).RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "sid-a", AgentType: "claude", AgentName: "a", WorkingDir: work, PermissionMode: tc.callerMode}))
			body := map[string]any{"working_dir": work, "agent_type": "claude", "flags": bypassFlags}
			path, handle := "/api/sessions/launch", h.Launch
			if team {
				body = map[string]any{"board_name": "t", "working_dir": work,
					"agents": []map[string]any{{"name": "Dev", "agent_type": "claude", "flags": bypassFlags}}}
				path, handle = "/api/sessions/launch-team", h.LaunchTeam
			}
			b, _ := json.Marshal(body)
			req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
			if tc.asAgent {
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
			}
			rec := httptest.NewRecorder()
			handle(rec, req)
			cmds := strings.Join(terminal.sentCommands(), "\n")
			if !tc.wantStart {
				// refused above the caller's rank (#14336): nothing starts, and the member (or the launch) says why
				assert.Contains(t, rec.Body.String(), agentLaunchAboveCallerCode, "%s team=%v: %s", tc.name, team, rec.Body.String())
				assert.Empty(t, cmds, "%s team=%v: nothing started", tc.name, team)
				continue
			}
			require.Equal(t, http.StatusOK, rec.Code, "%s team=%v: %s", tc.name, team, rec.Body.String())
			require.NotEmpty(t, cmds)
			for _, f := range []string{"--allowedTools", "Bash(*)", "/tmp/x.json", "--verbose"} {
				assert.Equal(t, tc.wantKept, strings.Contains(cmds, f), "%s team=%v: %s", tc.name, team, f)
			}
			// a bypass caller may start a bypass member; the flags outside the allowlist are still dropped
			assert.True(t, strings.Contains(cmds, "bypassPermissions") || strings.Contains(cmds, "--dangerously-skip-permissions"), "%s team=%v: %s", tc.name, team, cmds)
		}
	}
}

// The limits themselves, now the cap's (#14336): an agent's launch keeps --model and its deny rules; flags beyond it are dropped; allow rules, tools and hooks the caller does not have are refused.
func TestLimitAgentLaunch(t *testing.T) {
	grant, refusal := capAgentLaunchFor(callerAuthority{}, agentLaunchAsk{AgentType: "claude", Flags: []string{"--model", "opus", "--verbose", "--add-dir", "/"},
		Caps: &agent.Capabilities{Deny: []string{"Bash(rm *)"}}})
	require.Nil(t, refusal)
	assert.Equal(t, []string{"--model", "opus"}, grant.Flags)
	require.NotNil(t, grant.Caps)
	assert.Equal(t, []string{"Bash(rm *)"}, grant.Caps.Deny)
	assert.Empty(t, grant.Caps.Allow)
	for name, ask := range map[string]agentLaunchAsk{
		"an allow rule":  {AgentType: "claude", Caps: &agent.Capabilities{Allow: []string{"Bash(*)"}}},
		"an allowed tool": {AgentType: "claude", Tools: []string{"Bash"}},
		"a hook":          {AgentType: "claude", Hooks: map[string]interface{}{"PreToolUse": "x"}},
		"a bypass flag":   {AgentType: "claude", Flags: []string{"--permission-mode=bypassPermissions"}},
		"a sandbox flag":  {AgentType: "codex", Flags: []string{"--sandbox", "danger-full-access", "-s=x"}},
		"a yolo flag":     {AgentType: "gemini", Flags: []string{"--approval-mode=yolo", "-y"}},
	} {
		_, refusal := capAgentLaunchFor(callerAuthority{}, ask)
		require.NotNil(t, refusal, name)
		assert.Equal(t, agentLaunchAboveCallerCode, refusal.Code, name)
	}
}

// #4032 round 2: the agent's flags are an allowlist, so the spellings Security found past the
// old deny list (Codex -c/--config overrides and --profile, any --dangerously-* or
// --allow-dangerously-*, Claude's --agents and --plugin-dir) and a flag nobody has seen are
// removed, with their values.
func TestKeepAgentLaunchFlags(t *testing.T) {
	for _, tc := range []struct {
		in   []string
		want []string
	}{
		{[]string{"-c", "approval_policy=never"}, nil},
		{[]string{"--config", "sandbox_mode=danger-full-access"}, nil},
		{[]string{"--config=sandbox_mode=danger-full-access"}, nil},
		{[]string{"--profile", "wide"}, nil},
		{[]string{"--dangerously-anything"}, nil},
		{[]string{"--allow-dangerously-skip-permissions"}, nil},
		{[]string{"--agents", `{"x":{"tools":["Bash"]}}`}, nil},
		{[]string{"--plugin-dir", "/tmp/p"}, nil},
		{[]string{"--frobnicate", "--frobnicate=1"}, nil},
		{[]string{"--model", "opus"}, []string{"--model", "opus"}},
		{[]string{"--model=opus", "--verbose"}, []string{"--model", "opus"}},
		{[]string{"--model", "--dangerously-skip-permissions"}, nil},
		{[]string{"--model"}, nil},
	} {
		assert.Equal(t, tc.want, keepAgentLaunchFlags(tc.in), "%q", tc.in)
	}
}

// #4032 round 2: a member that is exactly an entry of a team template the Operator saved keeps
// its flags and allow rules when an agent launches the team; a copy with one extra tool or flag
// is limited like any other agent's choice.
func TestAgentLaunchOfASavedTemplateKeepsItsChoices(t *testing.T) {
	saved := `[{"name":"Wide","agents":[{"name":"Dev","prompt":"build","agent_type":"claude","flags":"--verbose --add-dir /srv","capabilities":{"deny":["Bash(rm *)"],"allow":["Bash(make *)"]}}]}]`
	member := map[string]any{"name": "Dev", "prompt": "build", "agent_type": "claude",
		"flags": []string{"--verbose", "--add-dir", "/srv"}, "capabilities": map[string]any{"allow": []string{"Bash(make *)"}, "deny": []string{"Bash(rm *)"}}}
	extraTool := map[string]any{}
	extraFlag := map[string]any{}
	for k, v := range member {
		extraTool[k], extraFlag[k] = v, v
	}
	extraTool["tools"] = []string{"Bash"}
	extraFlag["flags"] = []string{"--verbose", "--add-dir", "/srv", "--plugin-dir", "/tmp/p"}
	for _, tc := range []struct {
		name     string
		member   map[string]any
		wantKept bool
		refused  bool // beyond the caller's own tools (#14336): the member is not started
	}{{"the saved entry", member, true, false}, {"one extra tool", extraTool, false, true}, {"one extra flag", extraFlag, false, false}} {
		cfg := &config.Config{LogDir: t.TempDir()}
		db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
		require.NoError(t, err)
		t.Cleanup(func() { db.Close() })
		stubCLIPaths(t, store.NewSessionStore(db))
		require.NoError(t, store.NewSessionStore(db).SetSetting(context.Background(), "saved_team_templates", saved))
		terminal := newMockTerminal()
		h := NewSessionsHandler(db, cfg, nil, terminal, nil)
		work := t.TempDir() // an agent starts agents in its team's folder (#13891)
		callerCaps := `{"allow":["Bash(make *)"],"deny":["Bash(rm *)"]}` // the launching agent holds the saved entry's allow rule: a member's allow list is a subset of its own (#14336)
		require.NoError(t, store.NewSessionStore(db).RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "sid-a", AgentType: "claude", AgentName: "a", WorkingDir: work, Capabilities: &callerCaps}))
		b, _ := json.Marshal(map[string]any{"board_name": "t", "working_dir": work, "agents": []map[string]any{tc.member}})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, req)
		if tc.refused {
			assert.Contains(t, rec.Body.String(), agentLaunchAboveCallerCode, tc.name)
			assert.Empty(t, terminal.sentCommands(), "%s: nothing started", tc.name)
			continue
		}
		require.Equal(t, http.StatusOK, rec.Code, "%s: %s", tc.name, rec.Body.String())
		cmds := strings.Join(terminal.sentCommands(), "\n")
		require.NotEmpty(t, cmds)
		for _, f := range []string{"--verbose", "--add-dir", "/srv"} {
			assert.Equal(t, tc.wantKept, strings.Contains(cmds, f), "%s: %s", tc.name, f)
		}
		assert.NotContains(t, cmds, "/tmp/p", tc.name)
	}
	assert.True(t, inSavedTeamTemplate(map[string]string{"saved_team_templates": saved}, launchTeamAgent{Name: "Dev", Prompt: "build", AgentType: "claude",
		Flags: []string{"--verbose --add-dir", "/srv"}, Capabilities: &agent.Capabilities{Allow: []string{"Bash(make *)"}, Deny: []string{"Bash(rm *)"}}}, "claude"), "flags compare as words")
	assert.False(t, inSavedTeamTemplate(map[string]string{"saved_team_templates": saved}, launchTeamAgent{Name: "Dev", Prompt: "build", AgentType: "claude",
		Flags: []string{"--verbose", "--add-dir", "/srv"}, Capabilities: &agent.Capabilities{Allow: []string{"Bash(*)"}, Deny: []string{"Bash(rm *)"}}}, "claude"), "a wider allow rule")
	assert.False(t, inSavedTeamTemplate(map[string]string{}, launchTeamAgent{Name: "Dev"}, "claude"), "no saved templates")
}
