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
	for mode, wantGit := range map[string]bool{"default": true, "": false, "plan": true, "acceptEdits": true, "dontAsk": true, "bypassPermissions": false, "auto": false, "somethingNew": false} {
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
	// an empty mode (a print-mode run) is not Default: fail closed
	assert.False(t, hasGitRule(TranslateToClaudePermissionsForMode(caps, "").Allow))
}

// The mode the list is built from is the one appendPermissionMode writes (one function): a mode in the flags wins, then the launch's mode, else Default for an interactive launch; a print-mode run
// with Default or none writes nothing (""), and a permission flag nobody can read is "".
func TestTheClaudeLaunchModeIsTheOneTheCommandLineCarries(t *testing.T) {
	for _, c := range []struct {
		params      LaunchParams
		interactive bool
		want        string
	}{
		{LaunchParams{}, true, "default"},
		{LaunchParams{}, false, ""},
		{LaunchParams{PermissionMode: "default"}, false, ""},
		{LaunchParams{PermissionMode: "auto"}, true, "auto"},
		{LaunchParams{PermissionMode: "auto"}, false, "auto"},
		{LaunchParams{PermissionMode: "default", Flags: []string{"--permission-mode", "auto"}}, true, "auto"},
		{LaunchParams{PermissionMode: "auto", Flags: []string{"--permission-mode=plan"}}, true, "plan"},
		{LaunchParams{PermissionMode: "auto", Flags: []string{"--dangerously-skip-permissions"}}, true, "bypassPermissions"},
		{LaunchParams{PermissionMode: "default", Flags: []string{"--permission-mode", "nonsense"}}, true, ""},
	} {
		assert.Equal(t, c.want, claudeLaunchMode(c.params, c.interactive), "%+v interactive=%v", c.params, c.interactive)
		// and the command line agrees with it
		args := appendPermissionMode(nil, c.params, c.interactive)
		if _, fromFlags := claudePermissionMode(c.params, c.interactive); !fromFlags && c.want != "" {
			assert.Equal(t, []string{"--permission-mode", c.want}, args)
		}
	}
}

// A non-interactive launch (a scheduled job, a workflow step, PrintArgs) with no mode and git_write has no Bash(git ...) rule: nothing is written for the mode, so Auto's own default may apply.
func TestAPrintModeRunWithNoModeAndGitWriteHasNoGitRule(t *testing.T) {
	setTestHome(t, t.TempDir())
	a := &ClaudeAgent{}
	for _, mode := range []string{"", "default", "auto"} {
		args, settingsFile, err := a.PrintArgs(LaunchParams{WorkingDir: t.TempDir(), SessionID: "0b7f0f4e-3c1b-4c55-9b0e-0f6b1b2f1a11", PermissionMode: mode,
			Capabilities: &Capabilities{Allow: []string{CapShell, CapGitWrite}}})
		require.NoError(t, err, args)
		t.Cleanup(func() { os.Remove(settingsFile) })
		b, err := os.ReadFile(settingsFile)
		require.NoError(t, err)
		assert.NotContains(t, string(b), "Bash(git", "mode %q", mode)
	}
	args, settingsFile, err := a.PrintArgs(LaunchParams{WorkingDir: t.TempDir(), SessionID: "0b7f0f4e-3c1b-4c55-9b0e-0f6b1b2f1a11", PermissionMode: "plan", Capabilities: &Capabilities{Allow: []string{CapShell, CapGitWrite}}})
	require.NoError(t, err, args)
	t.Cleanup(func() { os.Remove(settingsFile) })
	b, _ := os.ReadFile(settingsFile)
	assert.Contains(t, string(b), "Bash(git push *)", "a mode that is written and asks keeps the rules")
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
		path := claudeSettingsFile(files, p, sid, true)
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
