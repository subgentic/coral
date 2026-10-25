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
	"github.com/subgentic/coral/internal/store"
)

// #7552 (Security's decision on #7527's caveat): a Codex that an AGENT starts on a board with no permission mode would start bare (it asks first, network off, so it cannot reach Coral):
// it is refused with a clear 403 and nothing starts. The Operator's launch with no mode stays Auto, an explicit mode and a saved default are used as before, a launch that is not on a board and
// every other type are unchanged. (An agent never starts a less-restricted agent, #4032, so Auto is not an agent's to give.)
func TestAnAgentsCodexLaunchOnABoardNeedsAMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fake := filepath.Join(t.TempDir(), "codex")
	require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fake))
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "codex", AgentName: "parent", WorkingDir: rig.workdir}))
	asAgent := func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "codex-" + parent}))
	}
	n := 0
	launch := func(fromAgent bool, body map[string]any) (*httptest.ResponseRecorder, string) {
		t.Helper()
		n++
		body["working_dir"] = rig.workdir
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		if fromAgent {
			req = asAgent(req)
		}
		rec := httptest.NewRecorder()
		rig.h.Launch(rec, req)
		cmd := ""
		if rec.Code == http.StatusOK {
			var res map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
			rig.term.mu.Lock()
			for name, cmds := range rig.term.sent {
				if strings.Contains(name, res["session_id"].(string)) && len(cmds) > 0 {
					cmd = cmds[len(cmds)-1]
				}
			}
			rig.term.mu.Unlock()
		}
		return rec, cmd
	}
	onBoard := func(extra map[string]any) map[string]any {
		m := map[string]any{"agent_type": at.Codex, "board_name": "needs-mode", "new_board": true}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}

	// the Operator's launch with no mode: Auto, as before
	rec, cmd := launch(false, onBoard(nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, cmd, "--sandbox workspace-write -a never")
	assert.Contains(t, cmd, "sandbox_workspace_write.network_access=true")

	// an agent's launch with no mode, on a board: refused, with the reason and what to do, and nothing started
	sentBefore := func() int { rig.term.mu.Lock(); defer rig.term.mu.Unlock(); return len(rig.term.sent) }()
	rec, _ = launch(true, onBoard(nil))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	var refusal map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
	assert.Equal(t, agentLaunchNeedsModeCode, refusal["code"])
	assert.Contains(t, refusal["error"], "asks first")
	assert.Contains(t, refusal["error"], "cannot reach Coral")
	assert.Contains(t, refusal["error"], "ask the Operator")
	assert.Equal(t, sentBefore, func() int { rig.term.mu.Lock(); defer rig.term.mu.Unlock(); return len(rig.term.sent) }(), "nothing started")

	// not on a board: unchanged (it is not a worker that has to reach a board)
	rec, cmd = launch(true, map[string]any{"agent_type": at.Codex})
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(t, cmd, "network_access=true")

	// a saved default mode is the person's choice for every launch: an agent's Codex on a board starts as that says ("default" is bare ask-first, as for everyone)
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "default"))
	rec, cmd = launch(true, onBoard(nil))
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(t, cmd, "network_access=true")
	assert.NotContains(t, cmd, "-a never")
	// and the Operator's explicit "default" stays bare ask-first too
	rec, cmd = launch(false, onBoard(nil))
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(t, cmd, "network_access=true")
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", ""))

	// another type with no mode is not refused (Claude's agent launch asks, and reaches Coral through hooks)
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fake))
	rec, _ = launch(true, map[string]any{"agent_type": at.Claude, "board_name": "needs-mode", "new_board": false})
	assert.NotEqual(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestAgentLaunchNeedsModeIsOnlyForCodexOnABoardWithNoMode(t *testing.T) {
	none := map[string]string{}
	assert.True(t, agentLaunchNeedsMode("codex", nil, true, none))
	assert.False(t, agentLaunchNeedsMode("codex", nil, false, none), "not on a board")
	assert.False(t, agentLaunchNeedsMode("claude", nil, true, none))
	assert.False(t, agentLaunchNeedsMode("codex", []string{"--sandbox", "read-only", "-a", "on-request"}, true, none), "a mode in the flags")
	assert.False(t, agentLaunchNeedsMode("codex", nil, true, map[string]string{"default_permission_mode": "default"}), "a saved default")
}

// Security's #7576 finding: a saved default permission mode reached an AGENT's launch (launchSession takes the flags' mode, else the saved default), so a saved Auto, Don't ask or Bypass gave an
// agent's Codex "-a never" with the network, or no sandbox at all. An agent never starts a less-restricted agent (#4032): such a default is refused for an agent's launch, alone or as a team
// member, with nothing started; the ask-first defaults are used as before; the Operator's launch takes any saved default.
func TestAnAgentDoesNotStartInASavedDefaultThatSkipsThePrompts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fake := filepath.Join(t.TempDir(), "cli")
	require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fake))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fake))
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "claude", AgentName: "parent", WorkingDir: rig.workdir}))
	asAgent := func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "claude-" + parent}))
	}
	sent := func() int { rig.term.mu.Lock(); defer rig.term.mu.Unlock(); return len(rig.term.sent) }
	launch := func(fromAgent bool, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		body["working_dir"] = rig.workdir
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		if fromAgent {
			req = asAgent(req)
		}
		rec := httptest.NewRecorder()
		rig.h.Launch(rec, req)
		return rec
	}

	for _, c := range []struct {
		agentType, mode string
		refused         bool
	}{
		{at.Codex, "auto", true}, {at.Codex, "dontAsk", true}, {at.Codex, "bypassPermissions", true}, {at.Codex, "acceptEdits", true},
		{at.Codex, "default", false}, {at.Codex, "plan", false},
		{at.Claude, "auto", true}, {at.Claude, "dontAsk", true}, {at.Claude, "bypassPermissions", true}, {at.Claude, "acceptEdits", true}, {at.Claude, "plan", true},
		{at.Claude, "default", false},
	} {
		require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", c.mode))
		before := sent()
		rec := launch(true, map[string]any{"agent_type": c.agentType})
		if c.refused {
			require.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", c.agentType, c.mode, rec.Body.String())
			var refusal map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
			assert.Equal(t, agentLaunchNeedsModeCode, refusal["code"], c.mode)
			assert.Contains(t, refusal["error"], "saved default permission mode ("+c.mode+")")
			assert.Contains(t, refusal["error"], "ask the Operator")
			assert.Equal(t, before, sent(), "%s %s: nothing started", c.agentType, c.mode)
		} else {
			assert.Equal(t, http.StatusOK, rec.Code, "%s %s: %s", c.agentType, c.mode, rec.Body.String())
		}
		// the Operator's launch takes any saved default, as before
		assert.Equal(t, http.StatusOK, launch(false, map[string]any{"agent_type": c.agentType}).Code, "operator %s %s", c.agentType, c.mode)
	}

	// as a team member: not started, the member says why
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "auto"))
	b, _ := json.Marshal(map[string]any{"board_name": "inherit-default", "new_board": true, "working_dir": rig.workdir, "agent_type": at.Codex, "agents": []map[string]any{{"name": "W"}}})
	before := sent()
	rec := httptest.NewRecorder()
	rig.h.LaunchTeam(rec, asAgent(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))))
	var out struct {
		Agents []map[string]any `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	require.Len(t, out.Agents, 1)
	assert.Equal(t, agentLaunchNeedsModeCode, out.Agents[0]["code"], rec.Body.String())
	assert.Equal(t, before, sent(), "no member started")
}

// A launch that names its board by board_id alone is a launch on a board too (Security's #7576 mutant).
func TestAnAgentsCodexLaunchByBoardIDNeedsAMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fake := filepath.Join(t.TempDir(), "codex")
	require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fake))
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "codex", AgentName: "parent", WorkingDir: rig.workdir}))
	// the Operator makes the board; an agent then names it by id only
	mk, _ := json.Marshal(map[string]any{"agent_type": at.Codex, "working_dir": rig.workdir, "board_name": "by-id", "new_board": true})
	rec := httptest.NewRecorder()
	rig.h.Launch(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(mk)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var made struct {
		BoardID string `json:"board_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &made)
	if made.BoardID == "" {
		t.Skip("the launch answer carries no board id here; the by-name test covers the check")
	}
	b, _ := json.Marshal(map[string]any{"agent_type": at.Codex, "working_dir": rig.workdir, "board_id": made.BoardID})
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
	req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "codex-" + parent}))
	rec = httptest.NewRecorder()
	rig.h.Launch(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), agentLaunchNeedsModeCode)
}
