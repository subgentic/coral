package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexCoralSandboxDefault(t *testing.T) {
	p := LaunchParams{SessionID: "11111111-2222-4333-8444-555555555555", CLIPath: "codex", PermissionMode: DefaultLaunchPermissionMode("codex")}
	cmd, err := (&CodexAgent{}).LaunchCommand(p)
	require.NoError(t, err)
	assert.Contains(t, cmd, "--sandbox workspace-write -a never")
	assert.Contains(t, cmd, "sandbox_workspace_write.network_access=true")
	assert.NotContains(t, cmd, "dangerously-bypass")
	assert.NotContains(t, cmd, "writable_roots", "Coral's token and board-state files only need read access")
	assert.True(t, SkipsPermissionPrompts("codex", PermissionFlagsForAgent("codex", p.PermissionMode)), "Hub classification remains skipping")
	for _, mode := range []string{"default", "plan", "acceptEdits", "bypassPermissions"} {
		p.PermissionMode = mode
		cmd, err = (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		assert.NotContains(t, cmd, "sandbox_workspace_write.network_access=true", mode)
		if mode == "bypassPermissions" {
			assert.Contains(t, cmd, "--dangerously-bypass-approvals-and-sandbox")
		}
	}
}

func TestCodexCoralSandboxExplicitPolicyWins(t *testing.T) {
	for _, flags := range [][]string{
		{"-c", "sandbox_workspace_write.network_access=false"},
		{"--config=sandbox_workspace_write.network_access=false"},
		{"-c=sandbox_workspace_write.network_access=false"},
	} {
		p := LaunchParams{PermissionMode: "auto", Flags: flags, CLIPath: "codex"}
		cmd, err := (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		assert.Less(t, strings.Index(cmd, "network_access=true"), strings.Index(cmd, "network_access=false"), cmd)
	}
	for _, p := range []LaunchParams{
		{PermissionMode: "auto", Flags: []string{"--sandbox", "read-only", "-a", "never"}},
		{PermissionMode: "auto", Flags: []string{"--sandbox", "workspace-write", "-a", "on-request"}},
		{PermissionMode: "auto", Capabilities: &Capabilities{Allow: []string{CapFileRead}}},
	} {
		p.CLIPath = "codex"
		cmd, err := (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		assert.NotContains(t, cmd, "sandbox_workspace_write.network_access=true")
	}
}

// The shell-only capability preset also yields workspace-write/never. It must
// not inherit the default's networking even though that final pair matches.
func TestCodexCoralSandboxCapabilityPresetKeepsItsNetworkPolicy(t *testing.T) {
	p := LaunchParams{CLIPath: "codex", PermissionMode: "auto", Capabilities: &Capabilities{Allow: []string{CapShell}}}
	cmd, err := (&CodexAgent{}).LaunchCommand(p)
	require.NoError(t, err)
	assert.Contains(t, cmd, "--sandbox workspace-write -a never")
	assert.NotContains(t, cmd, "sandbox_workspace_write.network_access", "a non-empty preset keeps its own network policy")
}

// #7483 (Codex Test's #7477): a Codex team member whose chips are Shell with no deny (the built-in Coding Team's) runs --sandbox workspace-write -a never, which has no network, so its coral-board calls could
// not reach Coral and it could neither read nor post on its board. A member of a board with that pair gets the same Coral reach as the default mode, whatever the mode; nothing else changes.
func TestCodexBoardMemberWithShellChipsReachesCoral(t *testing.T) {
	const net = "sandbox_workspace_write.network_access=true"
	launch := func(p LaunchParams) string {
		t.Helper()
		p.CLIPath, p.SessionID = "codex", "11111111-2222-4333-8444-555555555555"
		cmd, err := (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		return cmd
	}
	shell := &Capabilities{Allow: []string{CapShell}}
	fourChips := &Capabilities{Allow: []string{CapShell, CapFileRead, CapFileWrite, CapGitWrite}}
	for _, mode := range []string{"", "default", "auto", "dontAsk"} {
		for name, caps := range map[string]*Capabilities{"shell": shell, "the four chips": fourChips} {
			cmd := launch(LaunchParams{PermissionMode: mode, Capabilities: caps, BoardName: "coral-go-team"})
			assert.Contains(t, cmd, "--sandbox workspace-write -a never", "%s %q", name, mode)
			assert.Contains(t, cmd, net, "a board member with %s in mode %q reaches Coral", name, mode)
		}
	}
	// not a member of a board: the preset keeps its own network policy, as before
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "auto", Capabilities: shell}), net)
	// on-request keeps asking: the person who chose to be asked is asked (a board call raises its approval)
	for name, caps := range map[string]*Capabilities{
		"files only":      {Allow: []string{CapFileRead, CapFileWrite}},
		"shell with deny": {Allow: []string{CapShell}, Deny: []string{"Bash(rm:*)"}},
	} {
		cmd := launch(LaunchParams{PermissionMode: "default", Capabilities: caps, BoardName: "coral-go-team"})
		assert.NotContains(t, cmd, net, name)
	}
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "acceptEdits", BoardName: "coral-go-team"}), net, "accept edits asks")
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "plan", BoardName: "coral-go-team"}), net, "read-only")
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "bypassPermissions", Capabilities: shell, BoardName: "coral-go-team"}), net, "bypass needs none")
	assert.NotContains(t, launch(LaunchParams{Capabilities: &Capabilities{Allow: []string{CapFileRead}}, BoardName: "coral-go-team"}), net, "read-only caps")
	// an explicit network setting of the person's wins: it comes after Coral's default
	cmd := launch(LaunchParams{PermissionMode: "auto", Capabilities: shell, BoardName: "coral-go-team", Flags: []string{"-c", "sandbox_workspace_write.network_access=false"}})
	assert.Less(t, strings.Index(cmd, "network_access=true"), strings.Index(cmd, "network_access=false"), cmd)
	// the launch carries no write access to Coral's folder either way
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "auto", Capabilities: shell, BoardName: "coral-go-team"}), "writable_roots")
}

// #7483 / Codex Test's #7485: Auto sent as the FLAGS the dashboard turns it into (no permission mode) is the same launch as Auto sent as the mode: it gets Coral's network too. The old dialog and the new
// team dialog send flags, and those launches started a Codex whose coral-board could not connect.
func TestCodexAutoSentAsFlagsReachesCoralLikeTheMode(t *testing.T) {
	const net = "sandbox_workspace_write.network_access=true"
	launch := func(p LaunchParams) string {
		t.Helper()
		p.CLIPath = "codex"
		cmd, err := (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		return cmd
	}
	for name, flags := range map[string][]string{
		"long flags":   {"--sandbox", "workspace-write", "-a", "never"},
		"equals forms": {"--sandbox=workspace-write", "--ask-for-approval=never"},
		"short flags":  {"-s", "workspace-write", "-a", "never"},
	} {
		assert.Contains(t, launch(LaunchParams{Flags: flags}), net, name+": no mode, the pair is Auto")
		assert.Contains(t, launch(LaunchParams{PermissionMode: "default", Flags: flags}), net, name+": mode default, the pair is Auto")
	}
	// the other pairs and the other modes keep their own policy
	for name, flags := range map[string][]string{
		"on-request":    {"--sandbox", "workspace-write", "-a", "on-request"},
		"read-only":     {"--sandbox", "read-only", "-a", "never"},
		"untrusted":     {"--sandbox", "workspace-write", "-a", "untrusted"},
		"bypass":        {"--dangerously-bypass-approvals-and-sandbox"},
		"nothing typed": nil,
	} {
		assert.NotContains(t, launch(LaunchParams{Flags: flags}), net, name)
	}
	// a person's own network setting still wins
	cmd := launch(LaunchParams{Flags: []string{"--sandbox", "workspace-write", "-a", "never", "-c", "sandbox_workspace_write.network_access=false"}})
	assert.Less(t, strings.Index(cmd, "network_access=true"), strings.Index(cmd, "network_access=false"), cmd)
	// chips on no board keep their own policy
	assert.NotContains(t, launch(LaunchParams{Capabilities: &Capabilities{Allow: []string{CapShell}}, Flags: []string{"--sandbox", "workspace-write", "-a", "never"}}), net)
}
