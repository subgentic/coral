package reviewsize

import (
	"errors"
	"strings"
	"unicode"
)

// Caps on what an owner may save: a number outside them is refused with what is accepted, never clamped quietly.
const (
	MaxLines    = 1000000
	MaxFiles    = 100000
	MaxPattern  = 200
	MaxRoles    = 50
	MaxRoleName = 100
)

// RoleLimits are one role's own numbers; they replace the team's (both of them, so a role with only Lines has no files limit).
type RoleLimits struct {
	Lines int `json:"lines"`
	Files int `json:"files"`
}

// Setting is a team's review size guard (#21022, Warn mode): off by default, lines and/or files, the paths not counted, and who it applies to.
type Setting struct {
	On        bool                  `json:"on"`
	Lines     int                   `json:"lines"`
	Files     int                   `json:"files"`
	Skip      []string              `json:"skip"`
	OnlyRoles []string              `json:"only_roles"` // empty: the whole team
	Roles     map[string]RoleLimits `json:"roles"`
}

// Validate cleans a setting (trims, drops blanks and repeats) and refuses what is out of range. A setting that is off is always accepted: it is the default.
func (s Setting) Validate() (Setting, error) {
	if s.Lines < 0 || s.Lines > MaxLines {
		return s, errors.New("lines: a whole number from 0 to 1000000 (0 or empty: no lines limit)")
	}
	if s.Files < 0 || s.Files > MaxFiles {
		return s, errors.New("files: a whole number from 0 to 100000 (0 or empty: no files limit)")
	}
	if s.On && s.Lines == 0 && s.Files == 0 {
		return s, errors.New("set a lines limit or a files limit, or turn the guard off")
	}
	skip, err := cleanList(s.Skip, MaxSkip, MaxPattern, "skip path")
	if err != nil {
		return s, err
	}
	roles, err := cleanList(s.OnlyRoles, MaxRoles, MaxRoleName, "role")
	if err != nil {
		return s, err
	}
	if len(s.Roles) > MaxRoles {
		return s, errors.New("roles: at most 50 roles with their own numbers")
	}
	own := map[string]RoleLimits{}
	for name, l := range s.Roles {
		name = strings.TrimSpace(name)
		if name == "" || len(name) > MaxRoleName || hasControl(name) {
			return s, errors.New("roles: a role name is 1 to 100 characters")
		}
		if l.Lines < 0 || l.Lines > MaxLines || l.Files < 0 || l.Files > MaxFiles {
			return s, errors.New("roles: a role's numbers are from 0 to 1000000 lines and 100000 files")
		}
		if l.Lines == 0 && l.Files == 0 {
			return s, errors.New("roles: a role with its own numbers needs a lines or a files limit")
		}
		own[name] = l
	}
	s.Skip, s.OnlyRoles = skip, roles
	if len(own) == 0 {
		own = nil
	}
	s.Roles = own
	return s, nil
}

func cleanList(in []string, max, maxLen int, what string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if len(v) > maxLen || hasControl(v) {
			return nil, errors.New(what + ": at most 200 characters, no control characters")
		}
		k := strings.ToLower(v)
		if what == "skip path" {
			k = v
		}
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	if len(out) > max {
		return nil, errors.New(what + ": too many (at most 50)")
	}
	return out, nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// For gives the limits for a change by this role, and whether the guard judges it at all (off, or a role outside the list, is not judged).
func (s Setting) For(role string) (Limits, bool) {
	if !s.On {
		return Limits{}, false
	}
	if len(s.OnlyRoles) > 0 {
		found := false
		for _, r := range s.OnlyRoles {
			if strings.EqualFold(r, role) {
				found = true
			}
		}
		if !found {
			return Limits{}, false
		}
	}
	l := Limits{Lines: s.Lines, Files: s.Files, Skip: s.Skip}
	for name, own := range s.Roles {
		if strings.EqualFold(name, role) {
			l.Lines, l.Files = own.Lines, own.Files
		}
	}
	return l, true
}

// Verdict is what the review banner is made from.
type Verdict struct {
	Applies      bool `json:"applies"` // the guard is on for this role
	Over         bool `json:"over"`
	Lines        int  `json:"lines"`
	Files        int  `json:"files"`
	SkippedLines int  `json:"skipped_lines"`
	SkippedFiles int  `json:"skipped_files"`
	LimitLines   int  `json:"limit_lines"`
	LimitFiles   int  `json:"limit_files"`
}

// Verdict counts a change by the role's limits. A change the guard does not judge has Applies false and nothing else set.
func (s Setting) Verdict(role string, files []File) Verdict {
	l, ok := s.For(role)
	if !ok {
		return Verdict{}
	}
	r := Check(files, l)
	return Verdict{Applies: true, Over: r.Over, Lines: r.Lines, Files: r.Files, SkippedLines: r.SkippedLines, SkippedFiles: r.SkippedFiles, LimitLines: l.Lines, LimitFiles: l.Files}
}
