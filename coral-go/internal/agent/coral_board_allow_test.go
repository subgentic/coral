package agent

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// coralBoardSwitch is every subcommand in coral-board's own top-level switch, read from its source: a command added there is in neither of the two decision tables until someone decides.
func coralBoardSwitch(t *testing.T) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "../../cmd/coral-board/main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	ast.Inspect(f, func(n ast.Node) bool {
		sw, ok := n.(*ast.SwitchStmt)
		if !ok {
			return true
		}
		if id, ok := sw.Tag.(*ast.Ident); !ok || id.Name != "cmd" {
			return true
		}
		for _, c := range sw.Body.List {
			cc, ok := c.(*ast.CaseClause)
			if !ok {
				continue
			}
			for _, e := range cc.List {
				if lit, ok := e.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					if s, err := strconv.Unquote(lit.Value); err == nil {
						out = append(out, s)
					}
				}
			}
		}
		return false
	})
	sort.Strings(out)
	return out
}

// A subcommand added to coral-board's switch fails here until it is decided: pre-approved (one line saying why) or not (one line saying why). Security's rule (#14105): never the whole CLI.
func TestEveryCoralBoardSubcommandHasADecision(t *testing.T) {
	sw := coralBoardSwitch(t)
	if len(sw) < 30 {
		t.Fatalf("the switch scan found only %d subcommands: %v", len(sw), sw)
	}
	seen := map[string]bool{}
	for _, c := range sw {
		seen[c] = true
		_, yes := coralBoardPreApproved[c]
		_, no := coralBoardNotPreApproved[c]
		if yes == no {
			t.Errorf("coral-board %s is in %d decision tables: it must be in exactly one (coral_board_allow.go)", c, map[bool]int{true: 1, false: 0}[yes]+map[bool]int{true: 1, false: 0}[no])
		}
	}
	for c := range coralBoardPreApproved {
		if !seen[c] {
			t.Errorf("pre-approved %q is not a coral-board subcommand any more", c)
		}
	}
	for c := range coralBoardNotPreApproved {
		if !seen[c] {
			t.Errorf("%q is listed as not pre-approved but is not a coral-board subcommand any more", c)
		}
	}
	// the ones that must never be pre-approved, by name
	for _, never := range []string{"heavy", "resource", "send", "workflow", "export", "delete", "settings", "join"} {
		if _, ok := coralBoardPreApproved[never]; ok {
			t.Errorf("coral-board %s must never be pre-approved", never)
		}
	}
}

func TestTheBaselineRulesAreOnePerSubcommandNeverTheWholeCLI(t *testing.T) {
	allow, ask := coralBoardBaselineRules()
	want := map[string]bool{}
	for s := range coralBoardPreApproved {
		want["Bash(coral-board "+s+")"] = true
		want["Bash(coral-board "+s+" *)"] = true
	}
	if len(allow) != len(want) {
		t.Fatalf("allow rules %v, want exactly %d", allow, len(want))
	}
	meta := regexp.MustCompile("[;&|$`<>\n]")
	for _, r := range allow {
		if !want[r] {
			t.Errorf("unexpected allow rule %q", r)
		}
		if r == "Bash(coral-board *)" || r == "Bash(*)" || r == "Bash" || strings.HasPrefix(r, "Bash(coral-board *") {
			t.Errorf("never the whole CLI: %q", r)
		}
		if meta.MatchString(r) {
			t.Errorf("an allow rule with a shell metacharacter: %q", r)
		}
		for _, bad := range []string{"heavy", "resource", "coral-agent", "send", "workflow"} {
			if strings.Contains(r, bad) {
				t.Errorf("%q is never pre-approved: %q", bad, r)
			}
		}
	}
	// the ask rules keep a substitution out of the allowed commands
	for _, sub := range []string{"$(", "`", "<(", ">("} {
		found := false
		for _, r := range ask {
			found = found || strings.Contains(r, sub)
		}
		if !found {
			t.Errorf("no ask rule for %q", sub)
		}
	}
}

// What a launched Claude agent's settings file says: the board's talk is pre-approved whatever the mode, with and without capabilities, and the rest of what the capabilities wrote is kept.
func TestEveryClaudeAgentsSettingsPreApproveTheBoardsOwnTalk(t *testing.T) {
	a := &ClaudeAgent{}
	perms := func(p LaunchParams) map[string][]string {
		cmd := buildLaunch(a, p)
		m := regexp.MustCompile(`--settings '?([^ ']+)'?`).FindStringSubmatch(cmd)
		if m == nil {
			t.Fatalf("no settings file in %q", cmd)
		}
		raw, err := os.ReadFile(m[1])
		if err != nil {
			t.Fatal(err)
		}
		var s struct {
			Permissions map[string][]string `json:"permissions"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
		return s.Permissions
	}
	has := func(list []string, rule string) bool {
		for _, r := range list {
			if r == rule {
				return true
			}
		}
		return false
	}
	for _, tc := range []struct {
		name string
		p    LaunchParams
	}{
		{"ask-first, no capabilities (an Orchestrator's worker)", LaunchParams{PermissionMode: "default"}},
		{"no mode at all", LaunchParams{}},
		{"Auto", LaunchParams{PermissionMode: "auto"}},
		{"Plan", LaunchParams{PermissionMode: "plan"}},
		{"narrow capabilities", LaunchParams{PermissionMode: "default", Capabilities: &Capabilities{Allow: []string{CapFileRead, "shell:npm *"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := perms(tc.p)
			for _, r := range []string{"Bash(coral-board post *)", "Bash(coral-board post)", "Bash(coral-board read *)", "Bash(coral-board read)", "Bash(coral-board task *)", "Bash(coral-board goal *)", "Bash(coral-board wait *)", "Bash(coral-board status *)"} {
				if !has(got["allow"], r) {
					t.Errorf("missing allow rule %q in %v", r, got["allow"])
				}
			}
			for _, r := range got["allow"] {
				if strings.Contains(r, "coral-board heavy") || strings.Contains(r, "coral-board resource") || strings.Contains(r, "coral-agent") || r == "Bash(coral-board *)" {
					t.Errorf("a rule that must never be there: %q", r)
				}
			}
			if !has(got["ask"], "Bash(coral-board *$(*)") {
				t.Errorf("the substitution ask rule is missing: %v", got["ask"])
			}
		})
	}
	// what the capabilities wrote stays, and a deny stays a deny
	got := perms(LaunchParams{Capabilities: &Capabilities{Allow: []string{"shell:npm *"}, Deny: []string{CapFileWrite}}})
	if !has(got["allow"], "Bash(npm *)") || len(got["deny"]) == 0 {
		t.Errorf("the capabilities' own rules are kept: %v", got)
	}
}
