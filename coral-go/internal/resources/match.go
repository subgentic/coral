package resources

import (
	"strings"

	"github.com/subgentic/coral/internal/shellkill"
)

// MatchCommand is the first of the patterns a Bash call's command claims a resource by, or "", false. A pattern is words that must appear IN ORDER in ONE simple command of the call, the first being the
// program (by name): "go test ./..." matches `go test -count=1 ./...` and `cd x && CGO=0 go test ./... | tail`, not `go test -run X ./one/pkg` and not `echo "go test ./..."` or a commit message (a quoted
// text is one word). A command the reader cannot read within its bounds matches nothing: this is a guard against overlap, not a gate, so the command runs.
func MatchCommand(command string, patterns []string) (string, bool) {
	if len(patterns) == 0 || strings.TrimSpace(command) == "" {
		return "", false
	}
	cmds, ok := shellkill.Programs(command)
	if !ok {
		return "", false
	}
	for _, p := range patterns {
		want := strings.Fields(p)
		if len(want) == 0 {
			continue
		}
		for _, words := range cmds {
			if inOrder(words, want) {
				return p, true
			}
		}
	}
	return "", false
}

// inOrder reports whether want is a subsequence of words that starts at the program.
func inOrder(words, want []string) bool {
	if len(words) == 0 || words[0] != want[0] {
		return false
	}
	at := 1
	for _, w := range words[1:] {
		if at < len(want) && w == want[at] {
			at++
		}
	}
	return at == len(want)
}
