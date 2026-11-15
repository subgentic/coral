package resources

import (
	"strings"

	"github.com/subgentic/coral/internal/shellkill"
)

// MatchCommand is the first of the patterns a Bash call's command claims a resource by, or "", false. A pattern is words that must appear IN ORDER in ONE simple command of the call, the first being the
// program (by name): "go test ./..." matches `go test -count=1 ./...` and `cd x && CGO=0 go test ./... | tail`, not `go test -run X ./one/pkg` and not `echo "go test ./..."` or a commit message (a quoted
// text is one word). A command the reader cannot read within its bounds matches nothing: this is a guard against overlap, not a gate, so the command runs.
func MatchCommand(command string, patterns []string) (string, bool) {
	p, _, ok := matchWords(command, patterns)
	return p, ok
}

// matchWords is MatchCommand that also says WHICH command matched, as a short redacted line for the log (#14170: an "auto:" claim on a run that was on another machine could not be traced to its text): the matched command's program (its first word). It is never an argument, the whole command or a file's text.
func matchWords(command string, patterns []string) (pattern, matched string, ok bool) {
	if len(patterns) == 0 || strings.TrimSpace(command) == "" {
		return "", "", false
	}
	cmds, okp := shellkill.Programs(command)
	if !okp {
		return "", "", false
	}
	for _, p := range patterns {
		want := strings.Fields(p)
		if len(want) == 0 {
			continue
		}
		for _, words := range cmds {
			if inOrder(words, want) {
				return p, redactedWords(words), true
			}
		}
	}
	return "", "", false
}

// redactedWords is the matched command's PROGRAM only (its first word, cut at 40): Security's SHOULD on #14170, no argument and so no value or token can reach the log.
func redactedWords(words []string) string {
	if len(words) == 0 {
		return ""
	}
	w := words[0]
	if len(w) > 40 {
		w = w[:40]
	}
	return strings.ToValidUTF8(w, "")
}

// inOrder reports whether want is a subsequence of words that starts at the program.
func inOrder(words, want []string) bool {
	if len(words) == 0 || words[0] != want[0] {
		return false
	}
	at := 1
	for _, w := range words[1:] {
		if at < len(want) && (w == want[at] || canonPath(w) == canonPath(want[at])) {
			at++
		}
	}
	return at == len(want)
}

// MatchImage is for a process list that has no command lines (Windows, #13659): image is a program name ("go", "node") and it matches when it is the FIRST word of a pattern (compared in lower case, without
// .exe). It holds a slot only while the agent still runs a program the resource is about, which is coarser than the full match (go test ./... and go build are both "go"), and the safe way to be coarser:
// a slot is kept a little longer, never freed under a run that is going on.
func MatchImage(image string, patterns []string) bool {
	image = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(image)), ".exe")
	if image == "" || strings.ContainsAny(image, " \t") {
		return false
	}
	for _, p := range patterns {
		if w := strings.Fields(p); len(w) > 0 && strings.TrimSuffix(strings.ToLower(w[0]), ".exe") == image {
			return true
		}
	}
	return false
}

// canonPath is a package path in one spelling, so a pattern's spelling is not the only one that claims (goal #227: `go test ./internal/server/routes/` ran 9 minutes unclaimed against the pattern
// "go test ./internal/server/routes"): a trailing slash is dropped, a relative path gets its "./", and "/..." on a path (the package and everything under it) is dropped. A flag, an absolute path,
// "./..." itself and a word with no slash stay as they are. The package under it is still the same one, so ./internal/server/routesx does not match ./internal/server/routes.
func canonPath(w string) string {
	if w == "" || w[0] == '-' || w[0] == '/' || !strings.Contains(w, "/") {
		return w
	}
	for {
		t := strings.TrimSuffix(w, "/")
		if t != "./..." && t != "..." && strings.HasSuffix(t, "/...") && t != "." && len(t) > len("/...") {
			t = strings.TrimSuffix(t, "/...")
		}
		if t == w || t == "" || t == "." {
			break
		}
		w = t
	}
	if !strings.HasPrefix(w, "./") && !strings.HasPrefix(w, "../") && w != "..." {
		w = "./" + w
	}
	return w
}

// plainFilters are the programs that may stand around a matched command in a line that is run on another machine as it is: a change of folder and the filters a person puts after a test run to read less of it.
var plainFilters = map[string]bool{"cd": true, "tail": true, "head": true, "grep": true, "wc": true}

// OnlyMatched reports whether every simple command in command is one the patterns match, or a plain filter (cd, tail, head, grep, wc): nothing else rides along. A line that has any other command in it (a `;`
// or `&&` after the test run, a $( ) or a backtick, `bash -c`, curl) is not OnlyMatched, so the hook does not run it on another machine in the agent's place (#17587, Security's MUST: the whole line is wrapped,
// and a matched command anywhere in it is enough to match). False when the line cannot be read.
func OnlyMatched(command string, patterns []string) bool {
	cmds, ok := shellkill.Programs(command)
	if !ok || len(cmds) == 0 || hasFileRedirect(command) {
		return false
	}
	hit := false
	for _, words := range cmds {
		if len(words) == 0 {
			return false
		}
		matched := false
		for _, p := range patterns {
			if want := strings.Fields(p); len(want) > 0 && words[0] == want[0] && inOrder(words, want) { // the matched program starts the command: `env -S '...' go test` and `sudo go test` do not count (#17709)
				matched = true
				break
			}
		}
		switch {
		case matched:
			hit = true
		case plainFilters[words[0]]:
		case len(words) == 1 && words[0] == "1": // the parser reads the `1` of `2>&1` as a command of its own; it is no program
		default:
			return false
		}
	}
	return hit
}

// hasFileRedirect reports whether the line redirects to or from a file: `> out`, `>> out`, `2> err`, `< in`, or a here-document. A redirect would be made on the other machine, in a run folder that is deleted afterwards, not
// where the agent asked, and `> /etc/...` is written there as the run's user. Only `2>&1` (and `N>&M`) and a redirect to /dev/null stay (#17709). A quoted < or > is text, not a redirect.
func hasFileRedirect(command string) bool {
	rs := []rune(command)
	var quote rune
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else if c == '\\' && quote == '"' {
				i++
			}
		case c == '\'' || c == '"':
			quote = c
		case c == '\\':
			i++
		case c == '<' || c == '>':
			j := i + 1
			for j < len(rs) && (rs[j] == '>' || rs[j] == '|') { // >>, >|, <<
				j++
			}
			if c == '<' && j < len(rs) && rs[j] == '(' || c == '>' && j < len(rs) && rs[j] == '(' {
				return true // process substitution
			}
			if c == '>' && j < len(rs) && rs[j] == '&' { // 2>&1, >&2: one stream into another
				k := j + 1
				if k < len(rs) && rs[k] >= '0' && rs[k] <= '9' {
					i = k
					continue
				}
				return true // >&file
			}
			rest := strings.TrimLeft(string(rs[j:]), " \t")
			if c == '>' && (rest == "/dev/null" || strings.HasPrefix(rest, "/dev/null ") || strings.HasPrefix(rest, "/dev/null\t")) {
				i = j
				continue
			}
			return true
		}
	}
	return false
}
