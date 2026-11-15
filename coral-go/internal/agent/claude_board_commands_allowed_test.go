package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// #17547 (walk 77 M8): a team launched in Auto with no capabilities got a permission card for every `coral-board post` and `coral-board read`: with no capabilities no allow rules are written, and
// Auto's own judgement raised the harmless board commands. Coral's own board and agent tools are always allowed for a Claude launch, unless the person kept Full access (which writes nothing) or
// the capabilities deny the shell outright.
func TestClaudeAlwaysAllowsCoralsOwnBoardCommands(t *testing.T) {
	a := &ClaudeAgent{}
	allowOf := func(p LaunchParams) (allow []any, hasPerms bool) {
		cmd := buildLaunch(a, p)
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
		perms, ok := out["permissions"].(map[string]any)
		if !ok {
			return nil, false
		}
		allow, _ = perms["allow"].([]any)
		return allow, true
	}
	has := func(allow []any, want string) bool {
		for _, v := range allow {
			if v == want {
				return true
			}
		}
		return false
	}
	for _, mode := range []string{"auto", "default", "acceptEdits"} {
		allow, _ := allowOf(LaunchParams{PermissionMode: mode})
		for _, want := range []string{"Bash(coral-board *)", "Bash(coral-agent artifact *)", "Bash(coral-agent skills *)", "Bash(coral-agent history *)", "Bash(coral-agent check *)", "Bash(coral-agent docs *)", "Bash(coral-agent notify *)"} {
			if !has(allow, want) {
				t.Errorf("mode %q, no capabilities: %q is not allowed: %v", mode, want, allow)
			}
			// #17833: coral-agent is not allowed whole: launch would start team agents with no card for an injected worker in Auto
			for _, bad := range []string{"Bash(coral-agent *)", "Bash(coral-agent launch *)", "Bash(coral-agent)"} {
				if has(allow, bad) {
					t.Errorf("mode %q: %q must not be allowed: %v", mode, bad, allow)
				}
			}
		}
	}
	allow, _ := allowOf(LaunchParams{PermissionMode: "auto", Capabilities: &Capabilities{Allow: []string{CapFileRead, "shell:coral-board *"}}})
	n := 0
	for _, v := range allow {
		if v == "Bash(coral-board *)" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("a capability that already allows it is not doubled: %v", allow)
	}
	if allow, _ := allowOf(LaunchParams{PermissionMode: "auto", Capabilities: &Capabilities{Deny: []string{CapShell}}}); has(allow, "Bash(coral-board *)") {
		t.Errorf("a team denied the shell outright is not given it back: %v", allow)
	}
	// #17833: a role whose allow list names no shell (it cannot run a command) is not given the rules; one that allows some command is
	allow, _ = allowOf(LaunchParams{PermissionMode: "auto", Capabilities: &Capabilities{Allow: []string{CapFileRead, CapWebAccess}}})
	if has(allow, "Bash(coral-board *)") || has(allow, "Bash(coral-agent artifact *)") {
		t.Errorf("a role with no shell is not given Coral's commands: %v", allow)
	}
	if allow, _ = allowOf(LaunchParams{PermissionMode: "auto", Capabilities: &Capabilities{Allow: []string{CapFileRead, "shell:ls *"}}}); !has(allow, "Bash(coral-board *)") {
		t.Errorf("a role that allows a command keeps the board commands: %v", allow)
	}
	if _, ok := allowOf(LaunchParams{PermissionMode: "plan", KeepFullAccess: true}); ok {
		t.Errorf("Keep full access writes no rules at all")
	}
	// #17833 (QA3): a person's own global allow and deny survive the no-capabilities branch, with Coral's rules added to the allow list
	home := t.TempDir()
	setTestHome(t, home)
	writeSettingsFile(t, filepath.Join(home, ".claude"), "settings.json", map[string]interface{}{
		"permissions": map[string]interface{}{"allow": []string{"Read", "Bash(make test)"}, "deny": []string{"Bash(rm -rf *)"}},
	})
	cmd := buildLaunch(a, LaunchParams{PermissionMode: "auto"})
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
	perms, _ := out["permissions"].(map[string]any)
	got, _ := perms["allow"].([]any)
	for _, want := range []string{"Read", "Bash(make test)", "Bash(coral-board *)"} {
		if !has(got, want) {
			t.Errorf("the person's own allow list keeps %q beside Coral's: %v", want, got)
		}
	}
	if d, _ := perms["deny"].([]any); !has(d, "Bash(rm -rf *)") {
		t.Errorf("the person's own deny survives: %v", perms["deny"])
	}
}
