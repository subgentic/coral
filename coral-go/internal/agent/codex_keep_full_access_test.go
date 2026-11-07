package agent

import (
	"strings"
	"testing"
)

// The Operator's "Keep Full access when this agent restarts" choice (#14061) reaches the launch as LaunchParams.KeepFullAccess: every relaunch of a Codex agent that has it starts the CLI with the bypass
// switch and no other sandbox or approval flag, whatever the capability set, the permission mode or the stored flags say (the Operator outranks the Orchestrator's narrowing). Without it nothing changes.
func TestCodexKeepFullAccessOverridesTheNarrowSetOnEveryLaunch(t *testing.T) {
	a := &CodexAgent{}
	narrow := &Capabilities{Allow: []string{CapFileRead, CapFileWrite, CapWebAccess, "shell:npm *"}}
	const bypass = "--dangerously-bypass-approvals-and-sandbox"
	for _, tc := range []struct {
		name  string
		p     LaunchParams
		keep  bool
		extra string // a flag that must survive
	}{
		{"narrow capabilities", LaunchParams{Capabilities: narrow}, true, ""},
		{"narrow capabilities and an explicit plan mode", LaunchParams{Capabilities: narrow, PermissionMode: "plan"}, true, ""},
		{"stored narrow permission flags", LaunchParams{Flags: []string{"--sandbox", "read-only", "-a", "on-request"}}, true, ""},
		{"stored config overrides", LaunchParams{Flags: []string{"-c", "sandbox_mode=read-only", "-c", "approval_policy=on-request"}}, true, ""},
		{"a flag that is not a permission survives", LaunchParams{Capabilities: narrow, Flags: []string{"--sandbox", "workspace-write", "--search"}}, true, "--search"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.p.KeepFullAccess = true
			cmd := buildLaunch(a, tc.p)
			if strings.Count(cmd, bypass) != 1 {
				t.Errorf("want the bypass switch once, got %q", cmd)
			}
			for _, not := range []string{"--sandbox", " -a ", "sandbox_mode", "approval_policy", "workspace-write", "read-only", "on-request"} {
				if strings.Contains(cmd, not) {
					t.Errorf("no other sandbox or approval setting beside the bypass (%q found): %q", not, cmd)
				}
			}
			if tc.extra != "" && !strings.Contains(cmd, tc.extra) {
				t.Errorf("a flag that is not a permission is kept (%q): %q", tc.extra, cmd)
			}
			// without the choice it is what it was
			tc.p.KeepFullAccess = false
			if without := buildLaunch(a, tc.p); strings.Count(without, bypass) > 0 && tc.p.Capabilities != nil {
				t.Errorf("without the choice a narrow set stays narrow: %q", without)
			}
		})
	}
	// the narrow set alone, with the choice off, is the narrow pair: the choice changed it
	narrowCmd := buildLaunch(a, LaunchParams{Capabilities: narrow})
	if !strings.Contains(narrowCmd, "--sandbox workspace-write") || strings.Contains(narrowCmd, bypass) {
		t.Errorf("the narrow set without the choice: %q", narrowCmd)
	}
	// only Codex has it
	if cmd := buildLaunch(&ClaudeAgent{}, LaunchParams{SessionID: "s", KeepFullAccess: true}); strings.Contains(cmd, bypass) || strings.Contains(cmd, "--dangerously-skip-permissions") {
		t.Errorf("Claude's launch is unchanged by a Codex choice: %q", cmd)
	}
	// what a relaunch would run with, for the warning (#14051), says Full access when the choice is on
	if sb, ap := CodexLaunchPermissions(nil, narrow, "default", true); sb != "danger-full-access" || ap != "never" {
		t.Errorf("CodexLaunchPermissions with the choice on = %q, %q", sb, ap)
	}
}
