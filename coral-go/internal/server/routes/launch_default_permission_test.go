package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #5836: a Claude launch that nobody gave a permission mode starts in Auto, not in a bypass of every prompt (and not in prompts nobody is there to answer); what the person chose
// (flags, a saved default) stays theirs; the other CLIs start as before.
func TestAClaudeLaunchWithNoChosenPermissionModeStartsInAuto(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fakeClaude := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(fakeClaude, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fakeClaude))

	launch := func(body map[string]any) (cmd string, stored string) {
		t.Helper()
		body["working_dir"] = rig.workdir
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
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
		for name, cmds := range rig.term.sent { // this launch's own commands, not the last of any session's
			if strings.Contains(name, res["session_id"].(string)) {
				sent = cmds
			}
		}
		require.NotEmpty(t, sent, "keys: %v", rig.term.sent)
		return sent[len(sent)-1], stored
	}

	// nothing chosen: Auto, and Auto is what is stored for a restart or a team reset
	cmd, stored := launch(map[string]any{"agent_type": at.Claude})
	assert.Contains(t, cmd, "--permission-mode auto")
	assert.NotContains(t, cmd, "dangerously-skip-permissions")
	assert.NotContains(t, cmd, "bypassPermissions")
	assert.Equal(t, "auto", stored)

	// the person's own flags win: a mode, or a bypass
	cmd, stored = launch(map[string]any{"agent_type": at.Claude, "flags": []string{"--permission-mode", "plan"}})
	assert.Contains(t, cmd, "--permission-mode plan")
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.Equal(t, "plan", stored)
	cmd, stored = launch(map[string]any{"agent_type": at.Claude, "flags": []string{"--dangerously-skip-permissions"}})
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.Equal(t, "bypassPermissions", stored)

	// a saved default is the person's choice and applies as before (bypass stays bypass)
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "bypassPermissions"))
	cmd, stored = launch(map[string]any{"agent_type": at.Claude})
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.Equal(t, "bypassPermissions", stored)
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "default"))
	cmd, stored = launch(map[string]any{"agent_type": at.Claude})
	assert.Contains(t, cmd, "--permission-mode default", "a saved 'default' asks, and says so: Claude 2.1.283+ starts in Auto when no mode is given (#5894)")
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.Equal(t, "default", stored)

	// agy with nothing chosen starts in Auto too (#14741): recorded as Auto; its command has agy's own --mode auto only when its --help lists it (this stub lists nothing: no flag), and never a skip flag
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", ""))
	cmd, stored = launch(map[string]any{"agent_type": at.Agy})
	assert.NotContains(t, cmd, "--permission-mode auto")
	assert.NotContains(t, cmd, "--dangerously-skip-permissions")
	assert.Equal(t, "auto", stored)

	// Codex uses the sandbox default through the real launch route, and stores it
	// for restarts. Saved Settings modes still choose exactly what the person saved.
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fakeClaude))
	cmd, stored = launch(map[string]any{"agent_type": at.Codex})
	assert.Equal(t, "auto", stored)
	assert.Contains(t, cmd, "--sandbox workspace-write -a never")
	assert.Contains(t, cmd, "sandbox_workspace_write.network_access=true")
	assert.NotContains(t, cmd, "dangerously-bypass")
	for _, saved := range []string{"bypassPermissions", "default", "plan"} {
		require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", saved))
		cmd, stored = launch(map[string]any{"agent_type": at.Codex})
		assert.Equal(t, saved, stored)
		assert.NotContains(t, cmd, "sandbox_workspace_write.network_access=true")
		if saved == "bypassPermissions" {
			assert.Contains(t, cmd, "--dangerously-bypass-approvals-and-sandbox")
		}
		if saved == "plan" {
			assert.Contains(t, cmd, "--sandbox read-only -a on-request")
		}
	}
}

func TestTheDefaultLaunchPermissionModeIsAutoForClaudeAndCodex(t *testing.T) {
	assert.Equal(t, "auto", agent.DefaultLaunchPermissionMode("claude"))
	assert.Equal(t, "auto", agent.DefaultLaunchPermissionMode(""))
	assert.Equal(t, "auto", agent.DefaultLaunchPermissionMode(at.Codex))
	for _, agyType := range []string{at.Agy, at.Antigravity, at.Gemini} {
		assert.Equal(t, "auto", agent.DefaultLaunchPermissionMode(agyType), agyType+": agy has its own --mode auto (#14741)")
	}
	for _, other := range []string{"pi", "terminal"} {
		assert.Equal(t, "default", agent.DefaultLaunchPermissionMode(other), other)
	}
}

// A task run's auto-accept (the switch) adds Claude's Auto mode, not a bypass; a permission flag the run names itself stays; the other CLIs are as before (#5836).
func TestAnAutoAcceptingTaskRunStartsClaudeInAuto(t *testing.T) {
	assert.Equal(t, "--permission-mode auto", taskRunFlags("claude", "", true))
	assert.Equal(t, "--permission-mode auto", taskRunFlags("", "", true), "no agent type: Claude")
	assert.Equal(t, "--permission-mode auto --model x", taskRunFlags("claude", " --model x ", true))
	assert.Equal(t, "--permission-mode plan", taskRunFlags("claude", "--permission-mode plan", true), "the run's own mode stays")
	assert.Equal(t, "--permission-mode=acceptEdits", taskRunFlags("claude", "--permission-mode=acceptEdits", true))
	assert.Equal(t, "--dangerously-skip-permissions", taskRunFlags("claude", "--dangerously-skip-permissions", true), "a bypass the run names itself stays")
	assert.Equal(t, "--permission-mode auto", taskRunFlags("claude", "--permission-mode auto", true), "not added twice")
	assert.Equal(t, "--full-auto", taskRunFlags("codex", "", true))
	for _, agy := range []string{"agy", "antigravity", "gemini"} { // agy's own Auto, no longer its skip flag (#14772); the launch turns it into --mode auto only where agy lists it
		assert.Equal(t, "--permission-mode auto", taskRunFlags(agy, "", true), agy)
	}
	assert.Equal(t, "--model x", taskRunFlags("claude", " --model x ", false), "no auto-accept: the caller's flags only")
}

// Through the hub, Auto in the flags counts as skipping the prompts, as Windows round 4 decided (agent.SkipsPermissionPrompts: only default keeps them for Claude): an explicit
// --permission-mode auto needs the owner's switch, Launch mode and the dashboard's provenance; the default does not (Claude's Plan needs them too, #5894).
func TestAutoModeThroughTheHubCountsAsSkippingPrompts(t *testing.T) {
	assert.True(t, agent.SkipsPermissionPrompts("claude", []string{"--permission-mode", "auto"}), "Auto is the classifier approving for the agent")
	assert.True(t, agent.SkipsPermissionPrompts("claude", []string{"--permission-mode=auto"}))
	assert.True(t, agent.SkipsPermissionPrompts("claude", strings.Fields(taskRunFlags("claude", "", true))), "an auto-accepting task run's own flags")
	assert.False(t, agent.SkipsPermissionPrompts("claude", []string{"--permission-mode", "default"}))
	assert.True(t, agent.SkipsPermissionPrompts("claude", []string{"--permission-mode", "plan"}), "Claude's Plan runs classifier-approved commands without asking (#5894)")
}

// #5836, Security's FIX 2: the Auto default must not get past the Hub gate. A Hub-stamped launch or team member with no permission mode starts Claude in Auto only when the
// owner lets an agent skip prompts (switch on and Launch mode, the rule an explicit Auto meets); otherwise it asks ("default"); a launch from this computer starts in Auto; a
// saved default_permission_mode always wins; a restart restores what the session had and never gets the new default.
func TestTheAutoDefaultDoesNotGetPastTheHubGate(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	set := func(mode, allow string) {
		require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, mode))
		require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, allow))
	}
	launch := func(hub bool) string {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"agent_type": at.Claude, "working_dir": t.TempDir()})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		if hub {
			stamp(req)
		}
		rec := httptest.NewRecorder()
		h.Launch(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		ls, err := ss.GetLiveSession(ctx, res["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls)
		require.NotNil(t, ls.PermissionMode)
		return *ls.PermissionMode
	}
	// a team member goes through the same gate as a single launch (#14336, Security's MUST 2): the answer is the mode it started in, or the refusal's code with nothing started
	boardN := 0
	teamMember := func(hub bool) (mode, code string) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"board_name": "t" + strings.ReplaceAll(t.Name(), "/", "") + strconv.Itoa(boardN), "new_board": true, "working_dir": t.TempDir(), "agent_type": at.Claude,
			"agents": []map[string]any{{"name": "A", "agent_type": "claude"}}})
		boardN++
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
		if hub {
			stamp(req)
		}
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, req)
		var res struct {
			Code   string           `json:"code"`
			Agents []map[string]any `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res), rec.Body.String())
		if res.Code != "" { // refused for the whole request, before any member
			return "", res.Code
		}
		require.Len(t, res.Agents, 1, rec.Body.String())
		if c, _ := res.Agents[0]["code"].(string); c != "" {
			return "", c
		}
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		ls, err := ss.GetLiveSession(ctx, res.Agents[0]["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls.PermissionMode)
		return *ls.PermissionMode, ""
	}
	member := func(hub bool) string { m, c := teamMember(hub); return m + c }

	set("launch", "false") // the switch is off
	assert.Equal(t, "default", launch(true), "Hub launch, switch off: the agent asks")
	assert.Equal(t, "hub_auto_accept_disabled", member(true), "Hub team member, switch off: refused, never started in Auto")
	set("interact", "true") // the switch is on, below Launch
	assert.Equal(t, "default", launch(true), "Hub launch, below Launch mode: the agent asks")
	assert.Contains(t, []string{"hub_mode_too_low", "hub_auto_accept_disabled"}, member(true), "Hub team member, below Launch mode: refused")
	set("launch", "true")
	assert.Equal(t, "auto", launch(true), "Hub launch, switch on and Launch: Auto")
	assert.Equal(t, "auto", member(true), "Hub team member, switch on and Launch: the new default, Auto")
	set("view", "false")
	assert.Equal(t, "auto", launch(false), "a launch from this computer: Auto, whatever the Hub's settings")
	assert.Equal(t, "auto", member(false), "a team member from this computer: the new default, Auto")

	// The same default gate protects Codex's workspace-write/-a never mode.
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", ""))
	for _, allowed := range []string{"false", "true"} {
		set("launch", allowed)
		b, _ := json.Marshal(map[string]any{"agent_type": at.Codex, "working_dir": t.TempDir()})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		stamp(req)
		rec := httptest.NewRecorder()
		h.Launch(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		ls, err := ss.GetLiveSession(ctx, res["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls.PermissionMode)
		expected := "default"
		if allowed == "true" {
			expected = "auto"
		}
		assert.Equal(t, expected, *ls.PermissionMode, "Codex default obeys Hub auto-accept switch")
	}

	// a saved default wins, through the Hub as well
	set("launch", "false")
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "plan"))
	assert.Equal(t, "plan", launch(true), "a saved default is the owner's choice")
	assert.Equal(t, "plan", launch(false))
}

// #5836, Security's FIX 3: an agent never starts a less-restricted agent (#4032): its launch has every permission flag stripped, so a child with no flags must not start in Auto
// (it would ask for less than its parent). An agent-token launch, and a team member an agent launches that is not exactly a saved template entry, keep the old rule (the saved
// default, else default); the same from the dashboard gets Auto, and a saved template's member is unchanged (Auto).
func TestAnAgentsLaunchIsNotStartedInAutoByDefault(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	parentDir := t.TempDir() // an agent starts agents in its team's folder (#13891)
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "claude", AgentName: "parent", WorkingDir: parentDir}))
	asAgent := func(r *http.Request) *http.Request { // a request with an agent's verified session token
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "claude-" + parent}))
	}
	mode := func(sessionID string) string {
		ls, err := ss.GetLiveSession(ctx, sessionID)
		require.NoError(t, err)
		require.NotNil(t, ls)
		require.NotNil(t, ls.PermissionMode)
		return *ls.PermissionMode
	}
	launch := func(agentCaller bool) string {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"agent_type": at.Claude, "working_dir": parentDir})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		if agentCaller {
			req = asAgent(req)
		}
		rec := httptest.NewRecorder()
		h.Launch(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		return mode(res["session_id"].(string))
	}
	team := func(agentCaller bool, member map[string]any) string {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"board_name": "ag" + strings.ReplaceAll(t.Name(), "/", "") + fmt.Sprint(len(member)), "new_board": true, "working_dir": parentDir, "agent_type": at.Claude,
			"agents": []map[string]any{member}})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
		if agentCaller {
			req = asAgent(req)
		}
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res struct {
			Agents []map[string]any `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		require.Len(t, res.Agents, 1, rec.Body.String())
		return mode(res.Agents[0]["session_id"].(string))
	}
	plain := map[string]any{"name": "A", "agent_type": "claude"}

	// the parent's row records no mode: rank 0 (#14336). Every agent-made launch is capped by it; the Operator's is not.
	assert.Equal(t, "auto", launch(false), "from the dashboard: Auto")
	assert.Equal(t, "default", launch(true), "an agent's launch with no flags: the new default capped at the caller's rank")
	assert.Equal(t, "auto", team(false, plain), "a team member from the dashboard: the new default, Auto (#14336)")
	assert.Equal(t, "default", team(true, plain), "a team member an agent launches: capped at the caller")
	// a member that is exactly an entry of a template the Operator saved: the same cap
	require.NoError(t, ss.SetSetting(ctx, "saved_team_templates", `[{"name":"t","agents":[{"name":"S","agent_type":"claude"}]}]`))
	assert.Equal(t, "default", team(true, map[string]any{"name": "S", "agent_type": "claude"}), "a saved template member with nothing chosen: capped")
	// a saved default that skips the prompts is capped for the agent's child, never refused; the Operator's launch takes it
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "default"))
	assert.Equal(t, "default", launch(true))
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "acceptEdits"))
	assert.Equal(t, "default", launch(true), "capped at the caller: not acceptEdits")
	assert.Equal(t, "acceptEdits", launch(false), "the Operator's launch takes it")
}
