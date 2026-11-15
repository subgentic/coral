package agent

import (
	"encoding/json"
	"os"
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
		for _, want := range []string{"Bash(coral-board *)", "Bash(coral-agent *)"} {
			if !has(allow, want) {
				t.Errorf("mode %q, no capabilities: %q is not allowed: %v", mode, want, allow)
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
	if _, ok := allowOf(LaunchParams{PermissionMode: "plan", KeepFullAccess: true}); ok {
		t.Errorf("Keep full access writes no rules at all")
	}
}
