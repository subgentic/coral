package agent

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func hasGitRule(allow []string) bool {
	for _, a := range allow {
		if strings.HasPrefix(a, "Bash(git ") {
			return true
		}
	}
	return false
}

// #14350 (found by #14338): in Claude's Auto mode an allow rule decides before Auto's own judgement, so git_write's Bash(git push *) let a force push run unasked. In Auto git_write emits no
// Bash(git ...) rule; a blanket Bash allow stays (Auto still judges destructive git). In the other modes the rules stay: they only stop the question.
func TestGitWriteEmitsNoGitAllowRuleInAutoOnly(t *testing.T) {
	caps := &Capabilities{Allow: []string{CapFileRead, CapFileWrite, CapShell, CapGitWrite, CapAgentSpawn, CapWebAccess}}
	for mode, wantGit := range map[string]bool{"default": true, "": true, "plan": true, "acceptEdits": true, "dontAsk": true, "bypassPermissions": true, "auto": false} {
		p := TranslateToClaudePermissionsForMode(caps, mode)
		require.NotNil(t, p, mode)
		assert.Equal(t, wantGit, hasGitRule(p.Allow), "mode %q: %v", mode, p.Allow)
		assert.Contains(t, p.Allow, "Bash", "mode %q: the blanket Bash allow stays", mode)
	}
	// git_write alone in Auto: nothing allowed by Coral, Auto's judgement decides everything
	assert.Nil(t, TranslateToClaudePermissionsForMode(&Capabilities{Allow: []string{CapGitWrite}}, "auto"))
	// a deny rule only narrows and stays in Auto
	p := TranslateToClaudePermissionsForMode(&Capabilities{Allow: []string{CapGitWrite, CapShell}, Deny: []string{CapGitWrite}}, "auto")
	require.NotNil(t, p)
	assert.True(t, hasGitRule(p.Deny), "deny: %v", p.Deny)
	assert.False(t, hasGitRule(p.Allow))
	// the one-argument translator is the Default one
	assert.True(t, hasGitRule(TranslateToClaudePermissions(caps).Allow))
}

// The mode the list is built from is the one the launch really uses: a mode in the flags wins, then the launch's mode, else Default.
func TestTheClaudeLaunchModeIsTheOneTheCommandLineCarries(t *testing.T) {
	for _, c := range []struct {
		params LaunchParams
		want   string
	}{
		{LaunchParams{}, "default"},
		{LaunchParams{PermissionMode: "auto"}, "auto"},
		{LaunchParams{PermissionMode: "default", Flags: []string{"--permission-mode", "auto"}}, "auto"},
		{LaunchParams{PermissionMode: "auto", Flags: []string{"--permission-mode=plan"}}, "plan"},
		{LaunchParams{PermissionMode: "auto", Flags: []string{"--dangerously-skip-permissions"}}, "bypassPermissions"},
	} {
		assert.Equal(t, c.want, claudeLaunchMode(c.params), "%+v", c.params)
	}
}

// The settings file a launch writes: the same capabilities give the git rules in Default and none in Auto, whatever way Auto was asked for (the launch's mode or the flags); a relaunch of the same
// stored capabilities in another mode (a Restart, Resume or Wake that changes the mode) regenerates the list.
func TestTheSettingsFileDropsTheGitRulesWhenTheLaunchIsInAuto(t *testing.T) {
	setTestHome(t, t.TempDir())
	caps := &Capabilities{Allow: []string{CapFileRead, CapShell, CapGitWrite}}
	allowOf := func(p LaunchParams) []any {
		t.Helper()
		const sid = "0b7f0f4e-3c1b-4c55-9b0e-0f6b1b2f1a11"
		p.Capabilities, p.SessionID, p.WorkingDir = caps, sid, t.TempDir()
		files := &launchFiles{}
		path := claudeSettingsFile(files, p, sid)
		require.NoError(t, files.err)
		t.Cleanup(func() { os.Remove(path) })
		b, err := os.ReadFile(path)
		require.NoError(t, err)
		var s struct {
			Permissions struct {
				Allow []any `json:"allow"`
			} `json:"permissions"`
		}
		require.NoError(t, json.Unmarshal(b, &s))
		return s.Permissions.Allow
	}
	joined := func(a []any) string { b, _ := json.Marshal(a); return string(b) }
	assert.Contains(t, joined(allowOf(LaunchParams{PermissionMode: "default"})), "Bash(git push *)")
	assert.Contains(t, joined(allowOf(LaunchParams{})), "Bash(git push *)", "no mode: Default")
	assert.NotContains(t, joined(allowOf(LaunchParams{PermissionMode: "auto"})), "Bash(git")
	assert.Contains(t, joined(allowOf(LaunchParams{PermissionMode: "auto"})), `"Bash"`)
	assert.NotContains(t, joined(allowOf(LaunchParams{Flags: []string{"--permission-mode", "auto"}})), "Bash(git")
	// the same stored capabilities, started again in Default, have the rules back (and a Default start then an Auto start drops them again)
	assert.Contains(t, joined(allowOf(LaunchParams{PermissionMode: "default"})), "Bash(git push *)")
	assert.NotContains(t, joined(allowOf(LaunchParams{PermissionMode: "auto"})), "Bash(git")
}
