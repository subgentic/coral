package typedcensus

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Site is one place in a package's code that types text into an agent's terminal, and what that text is: Fragment must be in the call's
// line (the builder it calls, or the variable a builder filled), and Count is how many calls in File have it. Why says why it is safe:
// the census case that covers it, or why it is an exception.
type Site struct {
	File, Fragment string
	Count          int
	Why            string
}

// typing matches a call that types text into an agent's terminal: Coral's automated senders and the gate's wrappers.
var typing = regexp.MustCompile(`\b(sendAutomated|deliverAutomated|deliverAutomatedIfWanted|sendTaskNudge|sendUnlessBlocked|deliver)\(|SendPrompt\(ctx, terminalinput\.Coral`)

// CheckSites scans the package in dir (its non-test Go files) for calls that type text into an agent's terminal and requires each to be
// one of sites, with the counts given: a new call fails until its text comes from a builder in the census and it is listed here
// (Security on goal #7: a list of builders cannot show that it is complete; this can).
func CheckSites(t *testing.T, dir string, sites []Site) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	seen := make([]int, len(sites))
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		base := filepath.Base(f)
		for n, line := range strings.Split(string(b), "\n") {
			code := strings.TrimSpace(line)
			if strings.HasPrefix(code, "//") || strings.HasPrefix(code, "func ") || !typing.MatchString(code) {
				continue
			}
			matched := false
			for i, s := range sites {
				if s.File == base && strings.Contains(code, s.Fragment) {
					seen[i]++
					matched = true
					break
				}
			}
			if !matched {
				t.Errorf("%s:%d types text into an agent's terminal and is not in the census's list of call sites: build its text with a typed builder, add the builder to TestTypedNoticeCensus, and list the call here: %s", base, n+1, code)
			}
		}
	}
	for i, s := range sites {
		if seen[i] != s.Count {
			t.Errorf("%s: %d calls with %q, the list says %d (%s)", s.File, seen[i], s.Fragment, s.Count, s.Why)
		}
	}
}

// S is a Site: the file, the fragment its call's line holds, how many calls have it, and why it is safe.
func S(file, fragment string, count int, why string) Site {
	return Site{File: file, Fragment: fragment, Count: count, Why: why}
}
