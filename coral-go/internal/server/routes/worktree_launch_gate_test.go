package routes

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

func worktreeRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"}} {
		out, err := consoletest.HiddenCommand("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	return repo
}

// #12746 (the Operator: launching a team in a git worktree is failing for first-time users; it goes behind an Experimental setting, off by default): a team launch that asks for a worktree is refused with a plain
// 400 naming the setting, from any page or agent, while the setting is off (its default for every install), and nothing is created; with it on the launch goes ahead.
func TestATeamLaunchIntoAWorktreeIsRefusedWhileTheSettingIsOffAndAllowedWhileOn(t *testing.T) {
	cfg := config.Load(t.TempDir())
	server, _, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "cli_path_claude", filepath.Join(t.TempDir(), "no-such-cli"))) // nobody starts: the launch ends after the worktree step, which is what is looked at
	repo := worktreeRepo(t)
	body := func(board string) map[string]any {
		return map[string]any{"board_name": board, "working_dir": repo, "worktree": true, "base_branch": "main", "agent_type": "claude", "agents": []map[string]any{{"name": "A", "prompt": "x"}}}
	}
	// the default: off
	status, out := postTeam(t, server.URL, body("off-team"))
	assert.Equal(t, 400, status, "%v", out)
	assert.Contains(t, out["error"], "Enable launch into git worktree (experimental)", "the refusal names the setting")
	assert.Equal(t, WorktreeLaunchOffMessage, out["error"])
	entries, _ := filepath.Glob(filepath.Join(filepath.Dir(repo), "*", ".git"))
	for _, e := range entries {
		assert.NotContains(t, e, "off-team", "no worktree was made")
	}
	// a launch that asks for no worktree is not affected by the setting
	status, out = postTeam(t, server.URL, map[string]any{"board_name": "plain-team", "working_dir": repo, "agent_type": "claude", "agents": []map[string]any{{"name": "A", "prompt": "x"}}})
	assert.NotEqual(t, 400, status, "%v", out)
	if msg, _ := out["error"].(string); msg != "" {
		assert.NotContains(t, msg, "git worktree is turned off")
	}
	// on: the worktree launch goes ahead (it then fails for the missing CLI, a different answer)
	require.NoError(t, ss.SetSetting(ctx, "launch_in_worktree", "true"))
	status, out = postTeam(t, server.URL, body("on-team"))
	if msg, _ := out["error"].(string); msg != "" {
		assert.NotEqual(t, WorktreeLaunchOffMessage, msg, "with the switch on the setting is not what refuses: %d %v", status, out)
	}
	// and back off
	require.NoError(t, ss.SetSetting(ctx, "launch_in_worktree", "false"))
	status, out = postTeam(t, server.URL, body("off-again"))
	assert.Equal(t, 400, status)
	assert.Equal(t, WorktreeLaunchOffMessage, out["error"])
}

// A team already in a worktree keeps working with the switch off: its agents wake, with the worktree as their folder (nothing about an existing team depends on the setting).
func TestAnExistingWorktreeTeamStillWakesWhileTheSettingIsOff(t *testing.T) {
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	require.NoError(t, rig.ss.SetSetting(ctx, "cli_path_claude", stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")))
	repo := worktreeRepo(t)
	wt := filepath.Join(t.TempDir(), "coral-team-existing")
	out, err := consoletest.HiddenCommand("git", "-C", repo, "worktree", "add", "-q", "-b", "coral-team/existing", wt).CombinedOutput()
	require.NoError(t, err, string(out))
	require.NoError(t, rig.ss.SetSetting(ctx, "launch_in_worktree", "false"))
	sid := "bbbbbbbb-4444-5555-6666-000000000003"
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Member", WorkingDir: wt}))
	require.NoError(t, rig.ss.SetSessionSleeping(ctx, sid, true))
	asleep, err := rig.ss.GetLiveSession(ctx, sid)
	require.NoError(t, err)
	require.NoError(t, rig.h.wakeExistingSession(ctx, asleep))
	assert.NotEmpty(t, lastSentCommand(rig.term), "the member woke")
	ls, err := rig.ss.GetLiveSession(ctx, sid)
	require.NoError(t, err)
	assert.Equal(t, 0, ls.IsSleeping, "awake")
	assert.Equal(t, wt, ls.WorkingDir, "in its worktree")
}

// #12746: turning the experimental switch off does not touch a team that already lives in a worktree: it stops, resurrects into its worktree on its own branch, and its commits are kept, with the switch off.
func TestAWorktreeTeamResurrectsWithTheSwitchOff(t *testing.T) {
	url, cfg, h := teamServerH(t)
	git, id, wt := launchWorktreeTeam(t, url, cfg, "gate-resurrect")
	require.NoError(t, h.ss.SetSetting(context.Background(), "launch_in_worktree", "false"))
	require.NoError(t, os.WriteFile(filepath.Join(wt, "work.txt"), []byte("work"), 0o644))
	git("-C", wt, "add", "work.txt")
	git("-C", wt, "commit", "-q", "-m", "work")
	stopTeam(t, url, id)
	require.NoDirExists(t, wt)
	status, body := apiPost(t, url+"/api/teams/detail/"+id+"/resurrect")
	require.Equal(t, 200, status, body)
	assert.FileExists(t, filepath.Join(wt, "work.txt"), "back on its own branch, with its commits")
	// a new team into a worktree is refused all the same
	repo, _ := repoOn(t, "master", true)
	st, out := postTeam(t, url, map[string]any{"board_name": "gate-new", "working_dir": repo, "worktree": true, "agent_type": "claude", "agents": []map[string]any{{"name": "A", "prompt": "x"}}})
	assert.Equal(t, 400, st, "%v", out)
	assert.Equal(t, WorktreeLaunchOffMessage, out["error"])
}
