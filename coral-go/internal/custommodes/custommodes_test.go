package custommodes

import (
	"strings"
	"testing"
)

func TestFlagsAreAnAllowlistOfPermissionSwitches(t *testing.T) {
	good := map[string][][]string{
		"claude": {{"--permission-mode", "plan"}, {"--permission-mode=acceptEdits"}, {"--dangerously-skip-permissions"}},
		"codex":  {{"-s", "workspace-write", "-a", "on-request"}, {"--sandbox=read-only", "--search"}, {"--approve-for-me"}},
		"agy":    {{"--mode", "accept-edits"}, {"--sandbox"}},
		"hermes": {{"--yolo"}},
	}
	for typ, sets := range good {
		for _, f := range sets {
			if err := ValidateFlags(typ, f); err != nil {
				t.Errorf("%s %v refused: %v", typ, f, err)
			}
		}
	}
	bad := []struct {
		typ   string
		flags []string
		why   string
	}{
		{"claude", []string{"hello"}, "a bare positional"},
		{"claude", []string{"--"}, "the terminator"},
		{"claude", []string{"--dangerously-skip-permissions", "extra"}, "a bare word after a flag that takes none"},
		{"claude", []string{"--permission-mode", "plan", "extra"}, "a bare word after a value"},
		{"claude", []string{"--permission-mode"}, "a missing value"},
		{"claude", []string{"--permission-mode", "--foo"}, "a flag as a value"},
		{"claude", []string{"--permission-mode", "nonsense"}, "a value off the list"},
		{"claude", []string{"--permission-mode=/etc/passwd"}, "a path as a value"},
		{"claude", []string{"--append-system-prompt", "x"}, "a flag nobody listed"},
		{"claude", []string{"--permission-prompt-tool", "x"}, "a flag nobody listed"},
		{"claude", []string{"-pfoo"}, "a short cluster with a value"},
		{"claude", []string{"--dangerously-skip-permissions=1"}, "a value for a flag that takes none"},
		{"claude", []string{"--permission-mode", "plan", "--permission-mode", "auto"}, "a flag twice"},
		{"claude", []string{"--permission-mode=plan;rm"}, "a shell character"},
		{"claude", []string{"--permission-mode", "plan\n--settings"}, "a newline"},
		{"claude", []string{"--permission-mode", "pl an"}, "a space"},
		{"codex", []string{"-c", "notify=[x]"}, "a config override"},
		{"codex", []string{"--cd", "/tmp"}, "a directory flag"},
		{"codex", []string{"-i", "a.png"}, "an image flag"},
		{"codex", []string{"-m", "o3"}, "the model"},
		{"codex", []string{"-sfoo"}, "a short cluster with a value"},
		{"pi", []string{"--yolo"}, "an agent type with no list"},
		{"claude", nil, "no flags at all"},
		{"claude", make([]string, 9), "more than eight"},
	}
	for _, c := range bad {
		if ValidateFlags(c.typ, c.flags) == nil {
			t.Errorf("%s %q accepted: %s", c.typ, c.flags, c.why)
		}
	}
}

func TestEveryCoralOwnedFlagIsRefusedInBothForms(t *testing.T) {
	for _, typ := range Types() {
		for _, f := range CoralOwned {
			if ValidateFlags(typ, []string{f}) == nil || ValidateFlags(typ, []string{f + "=x"}) == nil || ValidateFlags(typ, []string{f, "x"}) == nil {
				t.Errorf("%s accepts %s", typ, f)
			}
		}
	}
	// the allowlist never holds a flag Coral owns
	for typ, specs := range allowed {
		for _, s := range specs {
			for _, n := range s.names {
				if ownedFlag(n) {
					t.Errorf("%s allows the Coral-owned %s", typ, n)
				}
			}
		}
	}
}

func TestBypassIsDecidedOnTheParsedFlag(t *testing.T) {
	yes := [][]string{
		{"--dangerously-skip-permissions"}, {"--allow-dangerously-skip-permissions"}, {"--permission-mode", "bypassPermissions"}, {"--permission-mode=bypassPermissions"},
	}
	for _, f := range yes {
		if !Bypass("claude", f) {
			t.Errorf("claude %v is not Bypass", f)
		}
	}
	for _, f := range [][]string{{"-s", "danger-full-access"}, {"--sandbox=danger-full-access"}, {"-a", "never"}, {"--ask-for-approval=never"}, {"--dangerously-bypass-approvals-and-sandbox"}} {
		if !Bypass("codex", f) {
			t.Errorf("codex %v is not Bypass", f)
		}
	}
	if !Bypass("agy", []string{"--dangerously-skip-permissions"}) || !Bypass("hermes", []string{"--yolo"}) {
		t.Error("agy or hermes bypass missed")
	}
	for _, f := range [][]string{{"--permission-mode", "plan"}, {"--permission-mode=default"}} {
		if Bypass("claude", f) {
			t.Errorf("claude %v is Bypass", f)
		}
	}
	if Bypass("codex", []string{"-s", "workspace-write", "-a", "on-request"}) {
		t.Error("a safe Codex pair is Bypass")
	}
	if !Bypass("claude", []string{"junk"}) {
		t.Error("an unreadable list is treated as the riskiest")
	}
}

func TestASetIsCheckedAsAWhole(t *testing.T) {
	n := 0
	mk := func() string { n++; return strings.Repeat("a", 7) + string(rune('0'+n)) }
	out, err := ValidateSet([]Mode{{AgentType: "claude", Name: " Plan only ", Flags: []string{"--permission-mode", "plan"}}}, mk)
	if err != nil || len(out) != 1 || out[0].ID == "" || out[0].Name != "Plan only" {
		t.Fatalf("a good set: %v %+v", err, out)
	}
	for _, c := range []struct {
		name string
		in   []Mode
		row  int
		fld  string
	}{
		{"a name that is empty", []Mode{{AgentType: "claude", Name: " ", Flags: []string{"--yolo"}}}, 0, "name"},
		{"an unsupported type", []Mode{{AgentType: "pi", Name: "x", Flags: []string{"--yolo"}}}, 0, "agent_type"},
		{"a bad flag", []Mode{{AgentType: "claude", Name: "x", Flags: []string{"--model", "x"}}}, 0, "flags"},
		{"a name twice", []Mode{{AgentType: "claude", Name: "A", Flags: []string{"--permission-mode=plan"}}, {AgentType: "claude", Name: "a", Flags: []string{"--permission-mode=auto"}}}, 1, "name"},
		{"a typed id", []Mode{{ID: "X!", AgentType: "claude", Name: "A", Flags: []string{"--permission-mode=plan"}}}, 0, "id"},
	} {
		_, err := ValidateSet(c.in, mk)
		ce, ok := err.(*Error)
		if !ok || ce.Row != c.row || ce.Field != c.fld {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	if len(Clean([]Mode{{ID: "abcdefgh", AgentType: "claude", Name: "ok", Flags: []string{"--permission-mode=plan"}}, {ID: "abcdefgi", AgentType: "claude", Name: "bad", Flags: []string{"--settings=x"}}})) != 1 {
		t.Error("Clean keeps a row that no longer passes")
	}
	if id, ok := IDOf("custom:abcdefgh"); !ok || id != "abcdefgh" {
		t.Error("IDOf")
	}
	if _, ok := IDOf("custom:../x"); ok {
		t.Error("IDOf takes a path")
	}
}
