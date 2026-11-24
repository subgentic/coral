package reviewsize

import (
	"strings"
	"testing"
)

func TestSettingValidate(t *testing.T) {
	long := strings.Repeat("a", 201)
	many := make([]string, MaxSkip+1)
	for i := range many {
		many[i] = "p" + strings.Repeat("x", i+1)
	}
	bad := map[string]Setting{
		"on with no limit":         {On: true},
		"negative lines":           {On: true, Lines: -1},
		"huge lines":               {On: true, Lines: 1000001},
		"huge files":               {On: true, Files: 100001},
		"too many skips":           {On: true, Lines: 5, Skip: many},
		"long skip":                {On: true, Lines: 5, Skip: []string{long}},
		"control in skip":          {On: true, Lines: 5, Skip: []string{"a\nb"}},
		"long role":                {On: true, Lines: 5, OnlyRoles: []string{long}},
		"role override no numbers": {On: true, Lines: 5, Roles: map[string]RoleLimits{"A": {}}},
		"role override negative":   {On: true, Lines: 5, Roles: map[string]RoleLimits{"A": {Lines: -3}}},
	}
	for name, s := range bad {
		if _, err := s.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Off is always fine, even with nothing set: it is the default.
	if _, err := (Setting{}).Validate(); err != nil {
		t.Fatalf("default refused: %v", err)
	}
	got, err := Setting{On: true, Lines: 800, Files: 20, Skip: []string{" *.lock ", "", "*.lock", "docs/**"}, OnlyRoles: []string{" Lead Developer", "lead developer"}}.Validate()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.Skip, "|") != "*.lock|docs/**" || len(got.OnlyRoles) != 1 || got.OnlyRoles[0] != "Lead Developer" {
		t.Fatalf("not cleaned: %+v", got)
	}
}

func TestSettingFor(t *testing.T) {
	s := Setting{On: true, Lines: 800, Files: 20, Skip: []string{"*.lock"}, OnlyRoles: []string{"Lead Developer", "Frontend Dev"}, Roles: map[string]RoleLimits{"frontend dev": {Lines: 300}}}
	if l, ok := s.For("Lead Developer"); !ok || l.Lines != 800 || l.Files != 20 || len(l.Skip) != 1 {
		t.Fatalf("lead: %+v %v", l, ok)
	}
	if l, ok := s.For("FRONTEND DEV"); !ok || l.Lines != 300 || l.Files != 0 {
		t.Fatalf("frontend override replaces both numbers, got %+v %v", l, ok)
	}
	if _, ok := s.For("QA Engineer"); ok {
		t.Fatal("a role outside the list is not judged")
	}
	if _, ok := (Setting{Lines: 5}).For("x"); ok {
		t.Fatal("off is never judged")
	}
	if _, ok := (Setting{On: true, Lines: 5}).For("anyone"); !ok {
		t.Fatal("no role list means the whole team")
	}
}

func TestVerdict(t *testing.T) {
	s := Setting{On: true, Lines: 100, Files: 3, Skip: []string{"*.lock"}}
	files := []File{{Path: "a.go", Added: 60, Deleted: 41}, {Path: "go.lock", Added: 500}}
	v := s.Verdict("Dev", files)
	if !v.Applies || !v.Over || v.Lines != 101 || v.Files != 1 || v.SkippedLines != 500 || v.SkippedFiles != 1 || v.LimitLines != 100 || v.LimitFiles != 3 {
		t.Fatalf("%+v", v)
	}
	files[0].Deleted = 40
	if v := s.Verdict("Dev", files); v.Over {
		t.Fatalf("at the limit is not over: %+v", v)
	}
	if v := (Setting{}).Verdict("Dev", files); v.Applies || v.Over {
		t.Fatalf("off: %+v", v)
	}
}
