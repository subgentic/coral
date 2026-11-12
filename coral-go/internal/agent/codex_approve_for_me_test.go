package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15780: Codex's Auto is its own auto-review (--approve-for-me) on a Codex that has it, and today's pair on one that does not.
func codexAutoLaunch(t *testing.T, version string, params LaunchParams) string {
	t.Helper()
	old := CodexVersionProbe
	t.Cleanup(func() { CodexVersionProbe = old })
	CodexVersionProbe = func(string) string { return version }
	params.SessionID = "11111111-2222-3333-4444-555555555555"
	params.SessionName = "codex-11111111-2222-3333-4444-555555555555"
	params.WorkingDir = t.TempDir()
	cmd, err := (&CodexAgent{}).LaunchCommand(params)
	require.NoError(t, err)
	return cmd
}

func TestCodexAutoIsTheAutoReviewOnACodexThatHasIt(t *testing.T) {
	autoFlags := []string{"--sandbox", "workspace-write", "-a", "never"}
	for _, c := range []struct {
		name   string
		params LaunchParams
	}{
		{"mode", LaunchParams{PermissionMode: "auto"}},
		{"dontAsk", LaunchParams{PermissionMode: "dontAsk"}},
		{"the flags the dashboard sends", LaunchParams{Flags: autoFlags}},
		{"--full-auto", LaunchParams{Flags: []string{"--full-auto"}}},
		{"permission-mode flag", LaunchParams{Flags: []string{"--permission-mode", "auto"}}},
		{"resume", LaunchParams{PermissionMode: "auto", ResumeSessionID: "99999999-2222-3333-4444-555555555555"}},
	} {
		cmd := codexAutoLaunch(t, "0.163.0", c.params)
		assert.Contains(t, cmd, "--approve-for-me", c.name)
		assert.NotContains(t, cmd, "--sandbox", c.name+": --approve-for-me carries the sandbox")
		assert.NotContains(t, cmd, " never", c.name+": and the approval policy")
		assert.Contains(t, cmd, "network_access=true", c.name+": Coral's own calls still reach it")
		assert.Equal(t, 1, strings.Count(cmd, "--approve-for-me"), c.name)
		for _, v := range []string{"0.162.9", "", "unreadable"} {
			old := codexAutoLaunch(t, v, c.params)
			assert.NotContains(t, old, "--approve-for-me", c.name+": Codex "+v+" keeps today's pair")
			assert.Contains(t, old, "--sandbox workspace-write -a never", c.name+" "+v)
		}
	}
}

func TestCodexAutoReviewLeavesEveryOtherPickAlone(t *testing.T) {
	wide := &Capabilities{Allow: []string{"shell"}}
	narrow := &Capabilities{Allow: []string{"shell"}, Deny: []string{"git_write"}}
	for _, c := range []struct {
		name   string
		params LaunchParams
		want   string
	}{
		{"Plan", LaunchParams{PermissionMode: "plan"}, "--sandbox read-only -a on-request"},
		{"Accept edits", LaunchParams{PermissionMode: "acceptEdits"}, "--sandbox workspace-write -a on-request"},
		{"Bypass", LaunchParams{PermissionMode: "bypassPermissions"}, "--dangerously-bypass-approvals-and-sandbox"},
		{"Full access kept", LaunchParams{PermissionMode: "auto", KeepFullAccess: true}, "--dangerously-bypass-approvals-and-sandbox"},
		{"Auto narrowed by a role's Shell rule", LaunchParams{PermissionMode: "auto", Capabilities: narrow}, "--sandbox workspace-write -a on-request"},
		{"Default with Shell and no deny (set by the capabilities, not an Auto pick)", LaunchParams{Capabilities: wide}, "--sandbox workspace-write -a never"},
	} {
		cmd := codexAutoLaunch(t, "0.170.0", c.params)
		assert.Contains(t, cmd, c.want, c.name)
		assert.NotContains(t, cmd, "--approve-for-me", c.name)
	}
}

func TestCodexAutoNoteSaysWhichAutoRuns(t *testing.T) {
	on := CodexAutoNote([]string{"--approve-for-me"}, nil, "auto", false)
	assert.Contains(t, on, "auto-review")
	assert.Contains(t, on, "outside the sandbox, such as writing outside the workspace, without asking you", "Security's #15795: the widening is said plainly")
	assert.Contains(t, on, "Shell rule", "a role's Shell rule may still narrow it, said in the note")
	off := CodexAutoNote([]string{"--sandbox", "workspace-write", "-a", "never"}, nil, "auto", false)
	assert.Contains(t, off, "older than 0.163.0")
	assert.Empty(t, CodexAutoNote([]string{"--sandbox", "workspace-write", "-a", "on-request"}, nil, "auto", false), "narrowed: CodexModeNote speaks")
	assert.Empty(t, CodexAutoNote([]string{"--sandbox", "read-only", "-a", "on-request"}, nil, "plan", false))
	assert.Empty(t, CodexAutoNote([]string{"--dangerously-bypass-approvals-and-sandbox"}, nil, "auto", true))
}
