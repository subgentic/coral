// Package healthcheck is the safe core of a custom health check (#20137, design v2 section 2 and 5): its output is data, never a command; its script runs from an owner-only snapshot, by exec and
// never through a shell, in its own process group, with an environment built from nothing, a timeout and a cap on what it may print.
package healthcheck

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// The limits of one run's output and of one line.
const (
	MaxLines = 20
	MaxBytes = 16 << 10
	MaxText  = 200
)

var (
	nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	keyRE  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
)

// ValidName is a check's name: [a-z0-9-], 1 to 40 characters, not starting with a dash.
func ValidName(s string) bool { return nameRE.MatchString(s) }

// ValidKey is a line's dedupe key.
func ValidKey(s string) bool { return keyRE.MatchString(s) }

// Levels a line may carry.
const (
	LevelInfo = "info"
	LevelWarn = "warn"
)

// Line is one thing a check has to say.
type Line struct {
	Key   string `json:"key"`
	Text  string `json:"text"`
	Level string `json:"level"`
	To    string `json:"to,omitempty"`
}

// CleanText makes a line's text fit to be shown to an agent as Coral's notice: one line, with control, ANSI and bidirectional characters gone, at most MaxText characters. (Redaction is the caller's: it
// needs the process's redactor.)
func CleanText(s string) string {
	s = clitext.Clean(s)
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > MaxText {
		s = string([]rune(s)[:MaxText])
	}
	return s
}

// ParseOutput reads a run's output: one JSON object per line. A line that is not valid (not JSON, a key or level that is none of the allowed, no text) is dropped and counted; at most MaxLines good
// lines are kept.
func ParseOutput(out string) (lines []Line, bad int) {
	for _, raw := range strings.Split(out, "\n") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if len(lines) >= MaxLines {
			break
		}
		var in struct {
			Key   string `json:"key"`
			Text  string `json:"text"`
			Level string `json:"level"`
			To    string `json:"to"`
		}
		dec := json.NewDecoder(strings.NewReader(raw))
		if err := dec.Decode(&in); err != nil || !ValidKey(in.Key) {
			bad++
			continue
		}
		level := in.Level
		switch level {
		case "":
			level = LevelInfo
		case LevelInfo, LevelWarn:
		default:
			bad++
			continue
		}
		text := CleanText(in.Text)
		if text == "" {
			bad++
			continue
		}
		lines = append(lines, Line{Key: in.Key, Text: text, Level: level, To: CleanText(in.To)})
	}
	return lines, bad
}

// Record is what the Operator approves: any change to it makes the check pending again. Files the script reads or sources are outside the hash (the approval row says so).
type Record struct {
	ScriptHash string   `json:"script_hash"`
	Args       []string `json:"args"`
	Dir        string   `json:"dir"`
	Every      string   `json:"every"`
	To         string   `json:"to"`
	ActsAs     string   `json:"acts_as"`
	Env        []string `json:"env"`
}

// Hash is the record's SHA-256: its JSON, in a fixed field order, so each argument is a unit (["a b"] is not ["a","b"]).
func (r Record) Hash() string {
	if r.Args == nil {
		r.Args = []string{}
	}
	if r.Env == nil {
		r.Env = []string{}
	}
	b, _ := json.Marshal(r)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
