package routes

import (
	"strings"
	"testing"
)

// #7201 round 3 (QA's review): a "/" inside a bracket expression of a sed address does not end the address (/[/]/p is the lines that hold a slash; BSD sed and the POSIX rule read it so), but
// sedScriptRuns ends the address at that "/" and then reads the rest of the script out of step, so an e, w or W command after such an address, or an s flag e or w, is not seen. Proven with the
// real sed on a Mac: the s///w form below writes the file it names. Every script here is valid sed; the commands are built at run time so the equivalence test's scan does not run them.
func sedCommand(script string) string {
	return strings.Join([]string{"sed", "-n", "'" + script + "'", "f"}, " ")
}

func TestShellRiskSedRunnerAfterABracketAddressAsks(t *testing.T) {
	wd := t.TempDir()
	addresses := []string{"/[/]/", "/a[/]b/", "/[^/]/", "/[a/b]/", "/[[:alpha:]/]/", "/[]/]/", "/[/]/,/x/", "1,/[/]/", "/x/,/[/]/", "/[/]/I"}
	runners := []string{"e id", "s/a/b/e", "w /tmp/qa-out", "s/a/b/w /tmp/qa-out", "s/a/b/gw /tmp/qa-out", "W /tmp/qa-out", "{p;e id}", "{n;{w /tmp/qa-out}}"}
	for _, a := range addresses {
		for _, r := range runners {
			for _, script := range []string{a + r, "p;" + a + r, a + "p;" + a + r} {
				if shellRisk(sedCommand(script), wd) == "" {
					t.Errorf("a sed script that runs a command or writes a file is judged safe: %q", script)
				}
			}
		}
	}
}

// What stays unasked: the same addresses with nothing that runs or writes.
func TestShellRiskSedBracketAddressWithoutARunnerStaysSafe(t *testing.T) {
	wd := t.TempDir()
	addresses := []string{"/[/]/", "/a[/]b/", "/[^/]/", "/[a/b]/", "/[[:alpha:]/]/", "/[]/]/", "/[/]/,/x/", "1,/[/]/", "/[/]/I"}
	commands := []string{"p", "d", "s/a/b/", "s/a/b/g", "y/ab/cd/", "{p;d}", "s/[/]/_/"}
	for _, a := range addresses {
		for _, c := range commands {
			if why := shellRisk(sedCommand(a+c), wd); why != "" {
				t.Errorf("a harmless sed script is asked about (%s): %q", why, a+c)
			}
		}
	}
}
