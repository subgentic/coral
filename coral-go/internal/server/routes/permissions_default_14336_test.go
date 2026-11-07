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
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/pkg/tunnel"
)

var fullCapsList14336 = []string{agent.CapShell, agent.CapFileRead, agent.CapFileWrite, agent.CapGitWrite, agent.CapAgentSpawn, agent.CapWebAccess}

// teamOf starts a one-member team through the router (the Operator's request) and returns the member's launch command.
func teamOf(t *testing.T, rig *agyTestRig, cli, board string, member map[string]any, hdr map[string]string) (int, string, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": rig.workdir, "agent_type": cli, "agents": []any{member}})
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	rig.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return rec.Code, rec.Body.String(), ""
	}
	return rec.Code, rec.Body.String(), lastSentCommand(rig.term)
}

// D's two tests (#14336): an unset saved default means the shipped default; a saved "default" wins everywhere.
func TestAnUnsetSavedDefaultMeansTheShippedDefaultAndASavedDefaultWinsEverywhere(t *testing.T) {
	for _, cli := range []string{at.Claude, at.Codex} {
		t.Run(cli, func(t *testing.T) {
			rig := setupAgyTestRig(t)
			fake := stubScript(t, filepath.Join(t.TempDir(), "mock-"+cli), "#!/bin/sh\nexit 0\n")
			ctx := context.Background()
			require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(cli), fake))
			shipped := map[string]string{at.Claude: "--permission-mode auto", at.Codex: "--sandbox workspace-write -a never"}[cli]
			single := func(board string) string {
				b, _ := json.Marshal(map[string]any{"agent_type": cli, "working_dir": rig.workdir, "board_name": board, "new_board": true})
				rec := httptest.NewRecorder()
				rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				return lastSentCommand(rig.term)
			}
			// unset: the shipped default, for a single launch and a team member
			require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", ""))
			assert.Contains(t, single("d-single-unset-"+cli), shipped, "single, unset")
			code, out, cmd := teamOf(t, rig, cli, "d-team-unset-"+cli, map[string]any{"name": "A"}, nil)
			require.Equal(t, http.StatusOK, code, out)
			assert.Contains(t, cmd, shipped, "team member, unset")
			// a saved "default" wins everywhere, the new default included
			require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", "default"))
			for label, cmd := range map[string]string{"single": single("d-single-saved-" + cli)} {
				assert.NotContains(t, cmd, shipped, label+", saved default")
				assert.NotContains(t, cmd, "-a never", label)
			}
			code, out, cmd = teamOf(t, rig, cli, "d-team-saved-"+cli, map[string]any{"name": "A"}, nil)
			require.Equal(t, http.StatusOK, code, out)
			assert.NotContains(t, cmd, shipped, "team member, saved default")
			assert.NotContains(t, cmd, "-a never", "team member, saved default")
		})
	}
}

// The guards that read "the Operator's saved default" read only the stored setting, never the shipped default (Security's point 5 of #14333): an unset default is not "skipping".
func TestTheInheritedDefaultGuardsReadOnlyTheStoredSetting(t *testing.T) {
	for _, typ := range []string{at.Claude, at.Codex, at.Agy} {
		_, inherits := agentLaunchInheritsSkippingDefault(typ, nil, map[string]string{})
		assert.False(t, inherits, "%s: an unset saved default is not skipping, whatever the shipped default is", typ)
		_, inherits = agentLaunchInheritsSkippingDefault(typ, nil, map[string]string{"default_permission_mode": "default"})
		assert.False(t, inherits, typ)
	}
	_, inherits := agentLaunchInheritsSkippingDefault(at.Claude, nil, map[string]string{"default_permission_mode": "bypassPermissions"})
	assert.True(t, inherits, "a stored Bypass is")
	assert.False(t, agentLaunchNeedsMode(at.Codex, nil, true, map[string]string{"default_permission_mode": "default"}))
}

// Build item (1): Codex stays in its sandbox. Full capabilities never translate to "no sandbox" (that is the Bypass mode, or Keep Full access, alone). Pinned per release of the translation:
// for every mode but Bypass, with and without the full capability set, the command carries no bypass flag and no danger-full-access.
func TestCodexWithFullCapabilitiesStaysInItsSandbox(t *testing.T) {
	for _, mode := range []string{"", "default", "plan", "acceptEdits", "auto", "dontAsk"} {
		for _, withCaps := range []bool{false, true} {
			t.Run(fmt.Sprintf("mode %q caps=%v", mode, withCaps), func(t *testing.T) {
				rig := setupAgyTestRig(t)
				fake := stubScript(t, filepath.Join(t.TempDir(), "mock-codex"), "#!/bin/sh\nexit 0\n")
				require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Codex), fake))
				m := map[string]any{"name": "A"}
				if mode != "" {
					m["permission_mode"] = mode
				}
				if withCaps {
					m["capabilities"] = map[string]any{"allow": fullCapsList14336}
				}
				code, out, cmd := teamOf(t, rig, at.Codex, fmt.Sprintf("cx-%s-%v", mode, withCaps), m, nil)
				require.Equal(t, http.StatusOK, code, out)
				for _, bad := range []string{"--dangerously-bypass-approvals-and-sandbox", "danger-full-access", "--yolo"} {
					assert.NotContains(t, cmd, bad, "Codex never leaves its sandbox without Bypass or Keep Full access")
				}
			})
		}
	}
	// and the explicit Bypass is the one way out, as before
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-codex"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Codex), fake))
	code, out, cmd := teamOf(t, rig, at.Codex, "cx-bypass", map[string]any{"name": "A", "permission_mode": "bypassPermissions"}, nil)
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, cmd, "--dangerously-bypass-approvals-and-sandbox")
}

// Build item (2): what every launch carries today, whatever its mode, is Coral's own hooks and the environment that lets the agent reach this Coral. There are NO deny rules for the data folder,
// the tmux socket or the tokens in any mode today (the settings file's permissions block holds only the capabilities'). One test pins that a full-capability launch in the new default carries
// the same hooks and environment as a plain one, and that its allow list is the capabilities' alone, with no deny rule dropped.
func TestAFullCapabilityLaunchCarriesCoralsOwnProtections(t *testing.T) {
	settingsOf := func(cmd string) map[string]any {
		t.Helper()
		m := regexp.MustCompile(`--settings (\S+)`).FindStringSubmatch(cmd)
		require.NotNil(t, m, cmd)
		b, err := os.ReadFile(strings.Trim(m[1], `'"`))
		require.NoError(t, err)
		var s map[string]any
		require.NoError(t, json.Unmarshal(b, &s))
		return s
	}
	run := func(board string, member map[string]any) map[string]any {
		rig := setupAgyTestRig(t)
		fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
		require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Claude), fake))
		code, out, cmd := teamOf(t, rig, at.Claude, board, member, nil)
		require.Equal(t, http.StatusOK, code, out)
		require.Contains(t, cmd, "--permission-mode auto")
		return settingsOf(cmd)
	}
	plain := run("prot-plain", map[string]any{"name": "A", "permission_mode": "default"})
	full := run("prot-full", map[string]any{"name": "A", "capabilities": map[string]any{"allow": fullCapsList14336, "deny": []string{"Bash(rm -rf *)"}}})
	assert.Equal(t, plain["hooks"], full["hooks"], "the same Coral hooks in every mode")
	require.NotNil(t, full["hooks"])
	pe, _ := plain["env"].(map[string]any)
	fe, _ := full["env"].(map[string]any)
	require.NotEmpty(t, fe["CORAL_URL"], "the environment that reaches this Coral")
	assert.Equal(t, pe["CORAL_URL"], fe["CORAL_URL"])
	perms, _ := full["permissions"].(map[string]any)
	require.NotNil(t, perms, "the capabilities' permissions block")
	assert.Contains(t, fmt.Sprint(perms["allow"]), "Bash")
	assert.Equal(t, []any{"Bash(rm -rf *)"}, perms["deny"], "a deny rule survives the full allow list")
}

// Security's MUST 2 for a Hub request: a team member that names nothing is gated like a single launch; a forged stamp and a grantee meet the same gate, and nothing starts when refused.
func TestAHubTeamMemberThatNamesNothingMeetsTheSameGateAsASingleLaunch(t *testing.T) {
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
	ctx := context.Background()
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fake))
	viaHub := map[string]string{"Content-Type": "application/json"}
	for k, v := range granteeHeaders() {
		viaHub[k] = v
	}
	set := func(mode, allow string) {
		require.NoError(t, rig.ss.SetSetting(ctx, MaxModeSetting, mode))
		require.NoError(t, rig.ss.SetSetting(ctx, AllowHubAutoAcceptSetting, allow))
	}
	n := 0
	try := func(hdr map[string]string) (int, string, string) {
		n++
		return teamOf(t, rig, at.Claude, fmt.Sprintf("hubgate-%d", n), map[string]any{"name": "A"}, hdr)
	}
	set("launch", "false")
	before := len(rig.term.sentCommands())
	code, out, _ := try(viaHub)
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Contains(t, out, "hub_auto_accept_disabled")
	assert.Equal(t, before, len(rig.term.sentCommands()), "switch off through a Hub stamp: nothing started, never Auto")
	set("interact", "true")
	code, out, _ = try(viaHub)
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Contains(t, out, "hub_mode_too_low")
	set("launch", "true")
	code, out, cmd := try(viaHub)
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, cmd, "--permission-mode auto", "switch on at Launch tier: the new default")
	code, out, _ = try(map[string]string{tunnel.ViaHeader: "forged"})
	assert.NotEqual(t, http.StatusOK, code, out)
	assert.Equal(t, before+1, len(rig.term.sentCommands()), "a forged stamp started nothing")
}

// Security's MUST 4 (#14333): the shipped full set for Claude is Read Glob Grep Write Edit Bash WebFetch WebSearch Agent, with NO Bash(git ...) rule (git_write is a capability a person picks on purpose;
// it turns off Auto's check on git pushes). A launch that names nothing but the set, in the new default (Auto), writes exactly that allow list.
func TestTheShippedFullSetCarriesNoGitAllowRule(t *testing.T) {
	shipped := []string{agent.CapFileRead, agent.CapFileWrite, agent.CapShell, agent.CapWebAccess, agent.CapAgentSpawn}
	for _, mode := range []string{"default", "plan", "acceptEdits", "auto", "dontAsk"} {
		p := agent.TranslateToClaudePermissionsForMode(&agent.Capabilities{Allow: shipped}, mode)
		require.NotNil(t, p)
		assert.ElementsMatch(t, []string{"Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "Agent"}, p.Allow, mode)
		assert.Empty(t, p.Deny)
	}
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Claude), fake))
	code, out, cmd := teamOf(t, rig, at.Claude, "shipped-set", map[string]any{"name": "A", "capabilities": map[string]any{"allow": shipped}}, nil)
	require.Equal(t, http.StatusOK, code, out)
	require.Contains(t, cmd, "--permission-mode auto")
	m := regexp.MustCompile(`--settings (\S+)`).FindStringSubmatch(cmd)
	require.NotNil(t, m)
	b, err := os.ReadFile(strings.Trim(m[1], `'"`))
	require.NoError(t, err)
	assert.NotContains(t, string(b), "Bash(git")
}

// Build item (3): a team relaunch (board_id of a board that exists) keeps what the template stored: a member that names no mode starts in the CLI's confirm mode, as before; the new default is for
// new teams. The form's explicit Default stays Default either way.
func TestATeamRelaunchByBoardIDKeepsTheConfirmModeForAMemberThatNamesNothing(t *testing.T) {
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Claude), fake))
	code, out, cmd := teamOf(t, rig, at.Claude, "relaunch-board", map[string]any{"name": "A"}, nil)
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, cmd, "--permission-mode auto", "a new team: the new default")
	var made struct {
		BoardID string `json:"board_id"`
	}
	require.NoError(t, json.Unmarshal([]byte(out), &made))
	require.NotEmpty(t, made.BoardID, out)
	relaunch := func(member map[string]any) string {
		body, _ := json.Marshal(map[string]any{"board_id": made.BoardID, "working_dir": rig.workdir, "agent_type": at.Claude, "agents": []any{member}})
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return lastSentCommand(rig.term)
	}
	cmd = relaunch(map[string]any{"name": "B"})
	assert.Contains(t, cmd, "--permission-mode default", "a relaunch keeps the confirm mode")
	assert.NotContains(t, cmd, "--permission-mode auto")
	cmd = relaunch(map[string]any{"name": "C", "flags": []string{"--permission-mode", "plan"}})
	assert.Contains(t, cmd, "--permission-mode plan", "what a member names is what it gets")
}

// The real proof for what a team member that names NO mode is spawned with (Frontend Dev's request on #14337, the Orchestrator's on #14336): the launch line of each type. Claude Auto, Codex's
// workspace-write with no approvals (never no-sandbox), Hermes Bypass (--yolo), Antigravity stays Default (no skip flag). The stored row says the same.
func TestATeamMemberThatNamesNoModeIsSpawnedWithEachTypesMapping(t *testing.T) {
	for _, c := range []struct {
		cli       string
		has, not  []string
		wantStore string
	}{
		{at.Claude, []string{"--permission-mode auto"}, []string{"bypassPermissions", "skip-permissions"}, "auto"},
		{at.Codex, []string{"--sandbox workspace-write -a never"}, []string{"--dangerously-bypass-approvals-and-sandbox", "danger-full-access"}, "auto"},
		{at.Hermes, []string{"--yolo"}, nil, "bypassPermissions"},
		{at.Agy, nil, []string{"--dangerously-skip-permissions", "--yolo"}, "default"},
	} {
		t.Run(c.cli, func(t *testing.T) {
			rig := setupAgyTestRig(t)
			fake := stubScript(t, filepath.Join(t.TempDir(), "mock-"+c.cli), "#!/bin/sh\nexit 0\n")
			require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(c.cli), fake))
			code, out, _ := teamOf(t, rig, c.cli, "map-"+c.cli, map[string]any{"name": "A"}, nil)
			require.Equal(t, http.StatusOK, code, out)
			cmd := "" // the line that starts the CLI (Hermes gets its prompt typed after it)
			for _, sent := range rig.term.sentCommands() {
				if strings.Contains(sent, fake) {
					cmd = sent
				}
			}
			require.NotEmpty(t, cmd, "the launch line")
			for _, h := range c.has {
				assert.Contains(t, cmd, h, c.cli)
			}
			for _, n := range c.not {
				assert.NotContains(t, cmd, n, c.cli)
			}
			var res struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal([]byte(out), &res))
			require.Len(t, res.Agents, 1)
			ls, err := rig.ss.GetLiveSession(context.Background(), res.Agents[0]["session_id"].(string))
			require.NoError(t, err)
			require.NotNil(t, ls)
			require.NotNil(t, ls.PermissionMode, "the row stores the mode the member started in")
			assert.Equal(t, c.wantStore, *ls.PermissionMode, c.cli)
		})
	}
}
