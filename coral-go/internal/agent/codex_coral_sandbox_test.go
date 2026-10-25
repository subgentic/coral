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

// #7489: with the loopback profile on, a launch that would get the broad network switch gets a permission profile instead: it extends the workspace sandbox, allows the network only through Codex's command proxy and
// only to 127.0.0.1, is selected with default_permissions, and the legacy --sandbox flag (which makes Codex drop a profile) is gone; the approval flag stays.
func TestCodexLoopbackProfileReplacesTheBroadSwitch(t *testing.T) {
	old, oldProbe := CodexLoopbackProfile, CodexVersionProbe
	t.Cleanup(func() { CodexLoopbackProfile, CodexVersionProbe = old, oldProbe })
	CodexLoopbackProfile = true
	CodexVersionProbe = func(string) string { return "0.163.0" }
	launch := func(p LaunchParams) string {
		t.Helper()
		p.CLIPath = "codex"
		cmd, err := (&CodexAgent{}).LaunchCommand(p)
		require.NoError(t, err)
		return cmd
	}
	const broad = "sandbox_workspace_write.network_access=true"
	shell := &Capabilities{Allow: []string{CapShell}}
	for name, p := range map[string]LaunchParams{
		"Auto as the mode":      {PermissionMode: "auto"},
		"Auto as flags":         {Flags: []string{"--sandbox", "workspace-write", "-a", "never"}},
		"chips on a board":      {Capabilities: shell, BoardName: "coral-go-team"},
		"Don't ask on a board":  {PermissionMode: "dontAsk", BoardName: "coral-go-team"},
		"the equals-form flags": {Flags: []string{"--sandbox=workspace-write", "--ask-for-approval=never"}},
	} {
		cmd := launch(p)
		assert.Contains(t, cmd, "features.network_proxy=true", name)
		assert.Contains(t, cmd, `permissions.coralonly={extends=":workspace", network={enabled=true, mode="limited", allow_local_binding=false, domains={"127.0.0.1"="allow"}}}`, name)
		assert.Contains(t, cmd, `default_permissions="coralonly"`, name)
		assert.Regexp(t, `-a never|--ask-for-approval=never`, cmd, name)
		assert.NotContains(t, cmd, "--sandbox", name+": the legacy flag makes Codex drop the profile")
		assert.NotContains(t, cmd, "--sandbox=", name)
		assert.NotContains(t, cmd, broad, name+": the broad switch is replaced")
	}
	// the profile's settings come before the person's own -c settings, so theirs still win
	cmd := launch(PermissionMode_("auto", []string{"-c", "model=\"x\""}))
	assert.Less(t, strings.Index(cmd, "default_permissions"), strings.Index(cmd, "model="), cmd)

	// not used: another approval pair, plan, bypass, a person's own network or permission setting, an older or unknown Codex, off
	for name, p := range map[string]LaunchParams{
		"on-request":      {Flags: []string{"--sandbox", "workspace-write", "-a", "on-request"}},
		"plan":            {PermissionMode: "plan"},
		"bypass":          {PermissionMode: "bypassPermissions"},
		"network off":     {PermissionMode: "auto", Flags: []string{"-c", "sandbox_workspace_write.network_access=false"}},
		"own profile":     {PermissionMode: "auto", Flags: []string{"-c", `default_permissions="mine"`}},
		"own permissions": {PermissionMode: "auto", Flags: []string{"-c", "permissions.mine.network.enabled=false"}},
		"chips no board":  {PermissionMode: "auto", Capabilities: shell},
		"nothing at all":  {},
	} {
		assert.NotContains(t, launch(p), "default_permissions=\"coralonly\"", name)
	}
	CodexVersionProbe = func(string) string { return "0.162.0" }
	cmd = launch(LaunchParams{PermissionMode: "auto"})
	assert.NotContains(t, cmd, "coralonly", "an older Codex")
	assert.Contains(t, cmd, broad, "keeps the broad switch")
	CodexVersionProbe = func(string) string { return "" }
	assert.NotContains(t, launch(LaunchParams{PermissionMode: "auto"}), "coralonly", "unknown version")
	CodexVersionProbe = func(string) string { return "0.163.0" }
	CodexLoopbackProfile = false
	cmd = launch(LaunchParams{PermissionMode: "auto"})
	assert.NotContains(t, cmd, "coralonly", "off")
	assert.Contains(t, cmd, broad)
}

// PermissionMode_ builds launch params for a mode with extra flags.
func PermissionMode_(mode string, flags []string) LaunchParams {
	return LaunchParams{PermissionMode: mode, Flags: flags}
}
