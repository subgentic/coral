// Package typedcensus checks the notices Coral TYPES into agents' terminals (goal #7, #378) against the shells such a terminal may hold
// (an exited agent's PowerShell, or a cmd, bash or PowerShell a person started there). It is used by the census tests of the packages
// that build those notices (internal/server/routes, internal/background); it is not used by Coral itself.
package typedcensus

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/board"
)

// Hostile is one label that tries everything the three shells act on. A builder's every label is given this in the Hostile case.
var Hostile = strings.Join([]string{
	`a"; New-Item marker; "`, `$(New-Item marker)`, "`whoami`", `x & echo y > marker`, `x | more`, `(calc)`, `@(calc)`, `it's`,
	`]; calc #`, `%PATH%`, `^&calc`, "line\nrm -rf /", "\u201cquoted\u201d \u2018q\u2019", "\u2013dash \u2014Force", "\u202efdp.exe",
	"zero\u200bwidth", `{ calc }`, `!!`, `*`, `~`, `\\server\share`, `<NUL`,
}, " ")

// Case is one typed notice: what its builder makes with plain labels ("plain"), and with Hostile in every label.
type Case struct {
	Name           string
	Plain, Hostile string
}

// cmdChars are what cmd.exe acts on anywhere in a line; shellChars are what PowerShell or a POSIX shell act on.
const (
	cmdChars   = "&|<>()^%"
	shellChars = "$`;\"'{}@[]\\!*~\u201c\u201d\u2018\u2019\u2013\u2014"
)

// Run checks every case: its first word is one of board.TypedOpeners (fixed, in both forms); Hostile adds no character cmd, PowerShell
// or a POSIX shell acts on (each one's count is the same as with plain labels, so any it has belongs to the fixed sentence); it is one
// line; and, where PowerShell is installed, PowerShell's own parser finds no command but the opener and no sub-expression in it. The
// openers themselves must not be a program, cmdlet or alias on this computer.
func Run(t *testing.T, cases []Case) {
	t.Helper()
	for _, c := range cases {
		for _, form := range []struct{ which, line string }{{"plain", c.Plain}, {"hostile", c.Hostile}} {
			first, _, _ := strings.Cut(form.line, " ")
			if !isOpener(first) {
				t.Errorf("%s (%s): starts with %q, not a fixed opener %v: %q", c.Name, form.which, first, board.TypedOpeners, form.line)
			}
			if strings.ContainsAny(form.line, "\r\n\u2028\u2029") {
				t.Errorf("%s (%s): more than one line: %q", c.Name, form.which, form.line)
			}
		}
		for _, ch := range cmdChars + shellChars {
			if p, h := strings.Count(c.Plain, string(ch)), strings.Count(c.Hostile, string(ch)); h != p {
				t.Errorf("%s: a label put %q into the typed line (%d with plain labels, %d with hostile ones): %q", c.Name, ch, p, h, c.Hostile)
			}
		}
	}
	for _, o := range board.TypedOpeners {
		if p, err := exec.LookPath(o); err == nil {
			t.Errorf("the opener %q is a program on this computer (%s): a typed notice would run it", o, p)
		}
	}
	checkPowerShell(t, cases)
}

func isOpener(word string) bool {
	for _, o := range board.TypedOpeners {
		if word == o || strings.HasPrefix(word, o+"]") || (strings.HasPrefix(o, "[") && strings.HasPrefix(word, o)) {
			return true
		}
	}
	return false
}
