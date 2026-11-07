package routes

import (
	"strconv"
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
	"github.com/subgentic/coral/internal/board/boardtest"
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
	assert.NotContains(t, refusal["error"], "default permission mode", "an ask-first default would start a Codex that cannot reach Coral either: the words say only to ask the Operator")
	assert.Equal(t, sentBefore, func() int { rig.term.mu.Lock(); defer rig.term.mu.Unlock(); return len(rig.term.sent) }(), "nothing started")

	// not on a board: unchanged (it is not a worker that has to reach a board)
	rec, cmd = launch(true, map[string]any{"agent_type": at.Codex})
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(t, cmd, "network_access=true")

	// the cap (#14336): a saved default is capped by the caller's rank; a Codex caller with no recorded mode (rank 0) still cannot start a Codex on a board that asks first and cannot reach Coral
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "default"))
	rec, _ = launch(true, onBoard(nil))
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Equal(t, agentLaunchNeedsModeCode, jsonCode(t, rec))
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
	// the cap's version of #7552: a caller with no standing to hand out a mode that reaches Coral cannot start a Codex on a board that would have to ask first
	needs := func(typ string, flags []string, onBoard bool, def string) bool {
		_, refusal := capAgentLaunchFor(callerAuthority{}, agentLaunchAsk{AgentType: typ, Flags: flags, OnBoard: onBoard, DefaultMode: def})
		return refusal != nil && refusal.Code == agentLaunchNeedsModeCode
	}
	assert.True(t, needs("codex", nil, true, ""))
	assert.False(t, needs("codex", nil, false, ""), "not on a board")
	assert.False(t, needs("claude", nil, true, ""))
	assert.False(t, needs("codex", []string{"--sandbox", "read-only", "-a", "on-request"}, true, ""), "a mode in the flags is judged by what it names")
	assert.True(t, needs("codex", nil, true, "default"), "a saved default of default still leaves a Codex that asks first")
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

	// the cap replaces the refusal (#14336): whatever the saved default, an agent's launch starts, and never above the caller's rank (the caller's row records no mode: rank 0, ask first)
	for _, c := range []struct {
		agentType, mode string
		refused         bool
	}{
		{at.Codex, "auto", true}, {at.Codex, "dontAsk", true}, {at.Codex, "bypassPermissions", true}, {at.Codex, "acceptEdits", true},
		{at.Codex, "default", true}, {at.Codex, "plan", true},
		{at.Claude, "auto", false}, {at.Claude, "dontAsk", false}, {at.Claude, "bypassPermissions", false}, {at.Claude, "acceptEdits", false}, {at.Claude, "plan", false},
		{at.Claude, "default", false},
	} {
		require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", c.mode))
		before := sent()
		body := map[string]any{"agent_type": c.agentType}
		if c.agentType == at.Codex {
			body["board_name"], body["new_board"] = "inherit-"+c.mode, true
		}
		rec := launch(true, body)
		if c.refused {
			require.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", c.agentType, c.mode, rec.Body.String())
			assert.Equal(t, agentLaunchNeedsModeCode, jsonCode(t, rec), c.mode)
			assert.Equal(t, before, sent(), "%s %s: nothing started", c.agentType, c.mode)
		} else {
			require.Equal(t, http.StatusOK, rec.Code, "%s %s: %s", c.agentType, c.mode, rec.Body.String())
			rig.term.mu.Lock()
			var last string
			for _, cmds := range rig.term.sent {
				if len(cmds) > 0 {
					last = cmds[len(cmds)-1]
				}
			}
			rig.term.mu.Unlock()
			assert.NotContains(t, strings.ToLower(last), "skip-permissions", "%s %s: capped to the caller", c.agentType, c.mode)
			assert.NotContains(t, last, "bypassPermissions", c.mode)
		}
		// the Operator's launch takes any saved default, as before
		opBody := map[string]any{"agent_type": c.agentType}
		if c.agentType == at.Codex {
			opBody["board_name"], opBody["new_board"] = "op-"+c.mode, true
		}
		assert.Equal(t, http.StatusOK, launch(false, opBody).Code, "operator %s %s", c.agentType, c.mode)
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

// #11713 (the Operator's request): an Orchestrator can launch agents for the person. Its launch used to be refused when the Operator's saved default skips the prompts; it now starts in the ask-first mode (never less
// restricted than itself) and the Operator raises it later. Any other agent is refused as before, a Codex stays refused (asking first, it cannot reach Coral), and the Operator's launch is unchanged.
func TestAnOrchestratorsLaunchStartsAskFirstWhereAnotherAgentIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fake := filepath.Join(t.TempDir(), "cli")
	require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fake))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fake))
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	rig.h.bs = bs
	const orch, worker = "11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666"
	for _, s := range []struct{ id, name, title string }{{orch, "orch", "Orchestrator"}, {worker, "worker", "Backend Dev"}} {
		require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: s.id, AgentType: "claude", AgentName: s.name, WorkingDir: rig.workdir}))
		_, err := bs.Subscribe(ctx, "launch-board", s.name, s.title, "claude-"+s.id, nil, "mentions")
		require.NoError(t, err)
	}
	as := func(id string) func(*http.Request) *http.Request {
		return func(r *http.Request) *http.Request {
			return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: id, SessionName: "claude-" + id}))
		}
	}
	launch := func(from func(*http.Request) *http.Request, agentType string) (*httptest.ResponseRecorder, string) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"agent_type": agentType, "working_dir": rig.workdir})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
		if from != nil {
			req = from(req)
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
	for _, mode := range []string{"auto", "bypassPermissions", "dontAsk", "acceptEdits", "plan"} {
		require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", mode))
		// no special case for an Orchestrator (#14336): every agent is capped by its own rank, and both rows record no mode (rank 0): ask first
		for _, who := range []string{orch, worker} {
			rec, cmd := launch(as(who), at.Claude)
			require.Equal(t, http.StatusOK, rec.Code, "%s, saved %s: %s", who, mode, rec.Body.String())
			assert.NotContains(t, strings.ToLower(cmd), "skip-permissions", "saved %s", mode)
			assert.NotContains(t, cmd, "bypassPermissions", "saved %s", mode)
			assert.NotContains(t, cmd, "--permission-mode "+mode, "saved %s: the saved default is capped by the caller", mode)
		}
		// the Operator: unchanged
		rec, _ := launch(nil, at.Claude)
		assert.Equal(t, http.StatusOK, rec.Code, "operator, saved %s", mode)
		// a Codex caller of rank 0 cannot start a Codex on a board that asks first
	}
	// As a team member: the Orchestrator's and another agent's member alike start capped to the caller.
	require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "auto"))
	team := func(from func(*http.Request) *http.Request, board string) []map[string]any {
		b, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": rig.workdir, "agent_type": at.Claude, "agents": []map[string]any{{"name": "Member"}}})
		rec := httptest.NewRecorder()
		rig.h.LaunchTeam(rec, from(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))))
		var out struct {
			Agents []map[string]any `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
		return out.Agents
	}
	for i, who := range []string{orch, worker} {
		got := team(as(who), "team-"+strconv.Itoa(i))
		require.Len(t, got, 1)
		assert.Empty(t, got[0]["error"], "the member starts: %v", got[0])
		sid, _ := got[0]["session_id"].(string)
		require.NotEmpty(t, sid, "the member's session: %v", got[0])
		memberCmd := ""
		rig.term.mu.Lock()
		for name, cmds := range rig.term.sent {
			if strings.Contains(name, sid) && len(cmds) > 0 {
				memberCmd = cmds[len(cmds)-1]
			}
		}
		rig.term.mu.Unlock()
		require.NotEmpty(t, memberCmd, "the member's launch command")
		assert.NotContains(t, strings.ToLower(memberCmd), "skip-permissions")
		assert.NotContains(t, memberCmd, "bypassPermissions")
		assert.NotContains(t, memberCmd, "--permission-mode auto", "the saved Auto is capped by the caller's rank")
	}
	// an agent that left its board is still capped by its own row, not refused: the Orchestrator exception is gone
	left, err := bs.Unsubscribe(ctx, "launch-board", "orch")
	require.NoError(t, err)
	require.True(t, left)
	rec, _ := launch(as(orch), at.Claude)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func jsonCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out["code"]
}
