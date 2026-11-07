package agent

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The Operator's "keep Full access" choice (#14061) extends to Claude and agy (#14085): a relaunch of either with the choice runs with nothing asking, whatever the role's capabilities or the
// mode say. The role presets carry lists like file_read, file_write and shell:coral-board *, which for agy used to turn a chosen Bypass into --mode accept-edits (the Operator's report).
func TestAgyKeepFullAccessOverridesNarrowCapabilitiesAndModes(t *testing.T) {
	a := &AgyAgent{}
	writer := &Capabilities{Allow: []string{CapFileRead, CapFileWrite, "shell:coral-board *"}}
	for _, tc := range []struct {
		name string
		p    LaunchParams
	}{
		{"the Technical Writer's list under a chosen Bypass", LaunchParams{Capabilities: writer, PermissionMode: "bypassPermissions", Flags: []string{"--dangerously-skip-permissions"}}},
		{"a read-only list", LaunchParams{Capabilities: &Capabilities{Allow: []string{CapFileRead}}}},
		{"an explicit plan mode", LaunchParams{PermissionMode: "plan"}},
		{"stored mode flags", LaunchParams{Flags: []string{"--mode", "plan"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			without := buildLaunch(a, tc.p)
			tc.p.KeepFullAccess = true
			cmd := buildLaunch(a, tc.p)
			if strings.Count(cmd, "--dangerously-skip-permissions") != 1 {
				t.Errorf("want the skip switch once: %q", cmd)
			}
			if strings.Contains(cmd, "--mode") {
				t.Errorf("no other mode beside it: %q", cmd)
			}
			if tc.name == "the Technical Writer's list under a chosen Bypass" && (!strings.Contains(without, "--mode accept-edits") || strings.Contains(without, "--dangerously-skip-permissions")) {
				t.Errorf("without the choice the list narrows the Bypass (that is the report): %q", without)
			}
		})
	}
}

func TestClaudeKeepFullAccessIsBypassAndWritesNoPermissionRules(t *testing.T) {
	a := &ClaudeAgent{}
	narrow := &Capabilities{Allow: []string{CapFileRead, "shell:coral-board *"}, Deny: []string{CapFileWrite}}
	p := LaunchParams{Capabilities: narrow, PermissionMode: "plan", Flags: []string{"--permission-mode", "acceptEdits", "--verbose"}}
	settingsOf := func(cmd string) map[string]any {
		m := regexp.MustCompile(`--settings '?([^ ']+)'?`).FindStringSubmatch(cmd)
		if m == nil {
			t.Fatalf("no settings file in %q", cmd)
		}
		raw, err := os.ReadFile(m[1])
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	without := buildLaunch(a, p)
	if _, ok := settingsOf(without)["permissions"]; !ok {
		t.Errorf("without the choice the capabilities write their rules: %q", without)
	}
	p.KeepFullAccess = true
	cmd := buildLaunch(a, p)
	if strings.Count(cmd, "--permission-mode bypassPermissions") != 1 {
		t.Errorf("want Bypass once: %q", cmd)
	}
	for _, not := range []string{"acceptEdits", "--permission-mode plan", "--permission-mode default"} {
		if strings.Contains(cmd, not) {
			t.Errorf("no other mode beside it (%q): %q", not, cmd)
		}
	}
	if !strings.Contains(cmd, "--verbose") {
		t.Errorf("a flag that is not a permission is kept: %q", cmd)
	}
	if _, ok := settingsOf(cmd)["permissions"]; ok {
		t.Errorf("the choice outranks the capabilities: no allow or deny rules in the settings")
	}
}
