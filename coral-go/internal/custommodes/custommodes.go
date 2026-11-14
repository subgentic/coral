// Package custommodes is the operator's own permission modes (#15950): a name, an agent type and the launch flags the mode adds instead of a built-in mode's.
//
// The flags reach the agent's launch command, so they are argv and nothing else, and they are checked against an ALLOWLIST per agent type (Security, #15950): the permission,
// sandbox and approval switches each CLI has, with how many values each takes and which. A flag that is not on the list is refused, whatever it is; a list of Coral's own flags
// (the session id, hooks, settings, resume, model...) is the second check. The same check runs when a set is saved, when it is read and when a launch builds its argv.
package custommodes

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	MaxModes   = 50  // modes in the whole set
	MaxFlags   = 8   // tokens in one mode
	MaxNameLen = 80  // characters of a display name
	MaxTokens  = 200 // characters of one token
	// Prefix is how a mode is named wherever a permission mode is stored or sent: "custom:<id>".
	Prefix = "custom:"
)

// Mode is one custom permission mode.
type Mode struct {
	ID        string   `json:"id"`
	AgentType string   `json:"agent_type"`
	Name      string   `json:"name"`
	Flags     []string `json:"flags"`
}

// Error names the row and the field of a refused set, as the custom models' does.
type Error struct {
	Row   int
	Field string
	Msg   string
}

func (e *Error) Error() string {
	if e.Row < 0 {
		return e.Msg
	}
	return fmt.Sprintf("custom mode %d, %s: %s", e.Row+1, e.Field, e.Msg)
}

// flagSpec is one flag a mode may carry: its names, and the values it takes (nil: none; otherwise exactly one of these).
type flagSpec struct {
	names  []string
	values []string
	bypass []string // the values (or "" for a flag that takes none) that turn the permission prompts off
}

var anyOf = func(s ...string) []string { return s }

// allowed is the allowlist, from each CLI's own --help and the flags Coral already translates for it. A CLI that has no permission switch (Pi) or none Coral knows (opencode) has no entry:
// no custom mode can be made for it.
var allowed = map[string][]flagSpec{
	"claude": {
		{names: []string{"--permission-mode"}, values: anyOf("default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"), bypass: anyOf("bypassPermissions")},
		{names: []string{"--dangerously-skip-permissions"}, bypass: anyOf("")},
		{names: []string{"--allow-dangerously-skip-permissions"}, bypass: anyOf("")},
	},
	"codex": {
		{names: []string{"-s", "--sandbox"}, values: anyOf("read-only", "workspace-write", "danger-full-access"), bypass: anyOf("danger-full-access")},
		{names: []string{"-a", "--ask-for-approval"}, values: anyOf("on-request", "never"), bypass: anyOf("never")},
		{names: []string{"--approve-for-me"}},
		{names: []string{"--search"}},
		{names: []string{"--dangerously-bypass-approvals-and-sandbox"}, bypass: anyOf("")},
	},
	"agy": {
		{names: []string{"--mode"}, values: anyOf("plan", "accept-edits", "auto")},
		{names: []string{"--sandbox"}},
		{names: []string{"--dangerously-skip-permissions"}, bypass: anyOf("")},
	},
	"hermes": {
		{names: []string{"--yolo"}, bypass: anyOf("")},
	},
}

// Family is the CLI an agent type runs on: Antigravity and Gemini are agy.
func Family(agentType string) string { return family(agentType) }

func family(agentType string) string {
	switch agentType {
	case "antigravity", "gemini":
		return "agy"
	}
	return agentType
}

// CoralOwned are the flags Coral puts on a launch itself (and the ones that name a file, a directory, a config or a session). None of them is on the allowlist; this is the
// second check, so a change to the allowlist cannot let one through. Both the --flag and --flag=value forms are matched.
var CoralOwned = []string{
	"--session-id", "--resume", "-r", "--continue", "-c", "--settings", "--setting-sources", "--mcp-config", "--strict-mcp-config", "--add-dir", "--hooks", "--config-dir",
	"--model", "-m", "--cwd", "-C", "--cd", "--print", "-p", "--output-format", "--input-format", "--plugin-dir", "--plugin-url", "--profile", "--config", "--effort",
	"--append-system-prompt", "--system-prompt", "--system-prompt-file", "--agents", "--permission-prompt-tool", "-i", "--image", "--enable", "--disable", "--fork-session", "--debug-file",
}

// Supported reports whether agentType can have custom modes.
func Supported(agentType string) bool { return len(allowed[family(agentType)]) > 0 }

// Types lists the agent types a custom mode can be made for.
func Types() []string { return []string{"claude", "codex", "agy", "hermes"} }

var tokenChars = regexp.MustCompile(`^[A-Za-z0-9._=:,+\[\]/-]+$`)

// canon is the canonical flag a token names (its first name), and whether it was "--flag=value" (value is then the part after "=").
func lookup(specs []flagSpec, tok string) (spec *flagSpec, value string, inline bool) {
	name := tok
	if i := strings.Index(tok, "="); i > 0 && strings.HasPrefix(tok, "--") {
		name, value, inline = tok[:i], tok[i+1:], true
	}
	for i := range specs {
		for _, n := range specs[i].names {
			if n == name {
				return &specs[i], value, inline
			}
		}
	}
	return nil, "", false
}

func ownedFlag(tok string) bool {
	name := tok
	if i := strings.Index(tok, "="); i > 0 {
		name = tok[:i]
	}
	for _, o := range CoralOwned {
		if o == name {
			return true
		}
	}
	return false
}

// parsed is one flag of a mode after the check: its spec's first name and its value.
type parsed struct {
	name, value string
	spec        *flagSpec
}

func parse(agentType string, flags []string) ([]parsed, error) {
	specs := allowed[family(agentType)]
	if len(specs) == 0 {
		return nil, fmt.Errorf("%s has no permission flags a custom mode can carry", agentType)
	}
	if len(flags) == 0 {
		return nil, fmt.Errorf("a custom mode needs at least one flag")
	}
	if len(flags) > MaxFlags {
		return nil, fmt.Errorf("at most %d flags", MaxFlags)
	}
	var out []parsed
	seen := map[string]bool{}
	for i := 0; i < len(flags); i++ {
		tok := flags[i]
		if tok == "" || len(tok) > MaxTokens {
			return nil, fmt.Errorf("flag %d is empty or longer than %d characters", i+1, MaxTokens)
		}
		if !tokenChars.MatchString(tok) {
			return nil, fmt.Errorf("flag %d: letters, digits and . _ = : , + [ ] / - only, one token per line, no spaces or quotes", i+1)
		}
		if strings.Contains(tok, "..") {
			return nil, fmt.Errorf("flag %d: no ..", i+1)
		}
		if tok == "--" || !strings.HasPrefix(tok, "-") {
			return nil, fmt.Errorf("flag %d: %q is not a flag (every token that is not a flag's value starts with -)", i+1, tok)
		}
		if ownedFlag(tok) {
			return nil, fmt.Errorf("flag %d: %s is one Coral sets itself", i+1, strings.SplitN(tok, "=", 2)[0])
		}
		spec, value, inline := lookup(specs, tok)
		if spec == nil {
			return nil, fmt.Errorf("flag %d: %s is not a permission flag a custom mode can carry for %s", i+1, strings.SplitN(tok, "=", 2)[0], agentType)
		}
		if len(spec.values) == 0 {
			if inline {
				return nil, fmt.Errorf("flag %d: %s takes no value", i+1, spec.names[len(spec.names)-1])
			}
		} else if !inline {
			if i+1 >= len(flags) {
				return nil, fmt.Errorf("flag %d: %s needs a value (%s)", i+1, tok, strings.Join(spec.values, ", "))
			}
			i++
			value = flags[i]
			if !tokenChars.MatchString(value) || strings.HasPrefix(value, "-") || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "~") || strings.HasPrefix(value, ".") {
				return nil, fmt.Errorf("flag %d: the value of %s must be one of %s", i, tok, strings.Join(spec.values, ", "))
			}
		}
		if len(spec.values) > 0 {
			ok := false
			for _, v := range spec.values {
				ok = ok || v == value
			}
			if !ok {
				return nil, fmt.Errorf("flag %d: %s takes %s", i+1, tok, strings.Join(spec.values, ", "))
			}
		}
		if seen[spec.names[0]] {
			return nil, fmt.Errorf("flag %d: %s is given twice", i+1, spec.names[len(spec.names)-1])
		}
		seen[spec.names[0]] = true
		out = append(out, parsed{name: spec.names[0], value: value, spec: spec})
	}
	return out, nil
}

// ValidateFlags is nil when flags are a custom mode's allowed flags for agentType.
func ValidateFlags(agentType string, flags []string) error {
	_, err := parse(agentType, flags)
	return err
}

// Bypass reports whether flags (already valid) turn the permission prompts off, decided on the parsed flag in every spelling: the flag, its = form, its value form.
func Bypass(agentType string, flags []string) bool {
	ps, err := parse(agentType, flags)
	if err != nil {
		return true // unreadable: treated as the riskiest
	}
	for _, p := range ps {
		for _, b := range p.spec.bypass {
			if b == p.value {
				return true
			}
		}
	}
	return false
}

var idPattern = regexp.MustCompile(`^[a-z0-9]{8,32}$`)

// ValidID reports whether id has the shape of a server-made id.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// IDOf is the id in a "custom:<id>" mode, and whether mode is one.
func IDOf(mode string) (string, bool) {
	id, ok := strings.CutPrefix(mode, Prefix)
	if !ok || !ValidID(id) {
		return "", false
	}
	return id, true
}

// Clean drops the rows that no longer pass (a stored row is checked again whenever it is read).
func Clean(in []Mode) []Mode {
	out := make([]Mode, 0, len(in))
	for _, m := range in {
		if checkOne(m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func checkOne(m Mode) error {
	if !ValidID(m.ID) {
		return fmt.Errorf("id")
	}
	if n := strings.TrimSpace(m.Name); n == "" || len([]rune(n)) > MaxNameLen || strings.ContainsAny(n, "\r\n\x00") {
		return fmt.Errorf("name")
	}
	return ValidateFlags(m.AgentType, m.Flags)
}

// ValidateSet checks a whole set as the operator sent it: new rows have no id (newID makes one), a kept row keeps its own. A problem names the row and the field.
func ValidateSet(in []Mode, newID func() string) ([]Mode, error) {
	if len(in) > MaxModes {
		return nil, &Error{Row: -1, Msg: fmt.Sprintf("at most %d custom modes", MaxModes)}
	}
	out := make([]Mode, 0, len(in))
	names := map[string]bool{}
	ids := map[string]bool{}
	for i, m := range in {
		m.AgentType = strings.TrimSpace(m.AgentType)
		m.Name = strings.TrimSpace(m.Name)
		if !Supported(m.AgentType) {
			return nil, &Error{Row: i, Field: "agent_type", Msg: fmt.Sprintf("%q has no custom modes (%s do)", m.AgentType, strings.Join(Types(), ", "))}
		}
		if m.Name == "" || len([]rune(m.Name)) > MaxNameLen || strings.ContainsAny(m.Name, "\r\n\x00") {
			return nil, &Error{Row: i, Field: "name", Msg: fmt.Sprintf("a name of 1 to %d characters", MaxNameLen)}
		}
		key := family(m.AgentType) + "\x00" + strings.ToLower(m.Name)
		if names[key] {
			return nil, &Error{Row: i, Field: "name", Msg: "two modes for one agent type have this name"}
		}
		names[key] = true
		if err := ValidateFlags(m.AgentType, m.Flags); err != nil {
			return nil, &Error{Row: i, Field: "flags", Msg: err.Error()}
		}
		if m.ID == "" {
			m.ID = newID()
		} else if !ValidID(m.ID) {
			return nil, &Error{Row: i, Field: "id", Msg: "an id is made by Coral: leave it empty for a new mode"}
		}
		if ids[m.ID] {
			return nil, &Error{Row: i, Field: "id", Msg: "two modes have this id"}
		}
		ids[m.ID] = true
		m.Flags = append([]string{}, m.Flags...)
		out = append(out, m)
	}
	return out, nil
}

// Describe is what each agent type's modes may carry, for the form's hint: "--flag value|value" per flag.
func Describe() map[string][]string {
	out := map[string][]string{}
	for _, typ := range Types() {
		for _, s := range allowed[family(typ)] {
			line := s.names[len(s.names)-1]
			if len(s.names) > 1 {
				line = strings.Join(s.names, ", ")
			}
			if len(s.values) > 0 {
				line += " <" + strings.Join(s.values, "|") + ">"
			}
			out[typ] = append(out[typ], line)
		}
	}
	return out
}
