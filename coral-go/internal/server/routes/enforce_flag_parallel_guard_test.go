package routes

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16337 (the #16309 class): the enforce flag is the process's, so a top-level test that runs in parallel and sets it turns it on under every other parallel test, and any of them that makes an
// unverified attributed request gets a 403 identity_unverified (six did). A test that sets the flag is not parallel at the top level (its subtests may be: it then has the package to itself).
//
// #16379 (Security's INFO on #16337): the guard read only each test's own body, so a helper that sets the flag, called from a parallel top-level test, was not caught. The guard now follows the
// package's helpers: a function in a _test.go file whose body sets the flag, or calls one that does, sets it too, to any depth.

var (
	enforceFlagTopFunc = regexp.MustCompile(`(?m)^func (?:\([^)]*\) )?(\w+)[\[(]`)
	enforceFlagTopTest = regexp.MustCompile(`^Test\w*$`)
	enforceFlagParTop  = regexp.MustCompile(`(?m)^\tt\.Parallel\(\)`)
)

// enforceFlagFuncs splits Go test sources into their top-level functions, name to body.
func enforceFlagFuncs(files map[string]string) map[string]map[string]string {
	out := map[string]map[string]string{}
	for f, src := range files {
		idx := enforceFlagTopFunc.FindAllStringSubmatchIndex(src, -1)
		funcs := map[string]string{}
		for i, m := range idx {
			end := len(src)
			if i+1 < len(idx) {
				end = idx[i+1][0]
			}
			funcs[src[m[2]:m[3]]] += src[m[1]:end]
		}
		out[f] = funcs
	}
	return out
}

// enforceFlagSetters is every function that sets the flag, itself or through the helpers it calls.
func enforceFlagSetters(funcs map[string]map[string]string) map[string]bool {
	setters := map[string]bool{}
	for changed := true; changed; {
		changed = false
		for _, byName := range funcs {
			for name, body := range byName {
				if setters[name] || enforceFlagTopTest.MatchString(name) {
					continue
				}
				if strings.Contains(body, "setIdentityActorEnforced(") || callsAny(body, setters) {
					setters[name] = true
					changed = true
				}
			}
		}
	}
	return setters
}

func callsAny(body string, names map[string]bool) bool {
	for n := range names {
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(n) + `\(`).MatchString(body) {
			return true
		}
	}
	return false
}

// parallelEnforceFlagOffenders lists the parallel top-level tests that set the flag, directly or through a helper.
func parallelEnforceFlagOffenders(files map[string]string) []string {
	funcs := enforceFlagFuncs(files)
	setters := enforceFlagSetters(funcs)
	var bad []string
	for f, byName := range funcs {
		for name, body := range byName {
			if !enforceFlagTopTest.MatchString(name) {
				continue
			}
			head := body
			if n := strings.Index(body, "\n\t"+"t.Run("); n >= 0 {
				head = body[:n]
			}
			// parallel at the top level: t.Parallel() as one of the test's own first statements (before any t.Run)
			if enforceFlagParTop.MatchString(head) && (strings.Contains(body, "setIdentityActorEnforced(") || callsAny(body, setters)) {
				bad = append(bad, f+": "+name)
			}
		}
	}
	sort.Strings(bad)
	return bad
}

func TestNoParallelTopLevelTestSetsTheEnforceFlag(t *testing.T) {
	paths, err := filepath.Glob("*_test.go")
	require.NoError(t, err)
	files := map[string]string{}
	for _, f := range paths {
		raw, err := os.ReadFile(f)
		require.NoError(t, err)
		files[f] = string(raw)
	}
	assert.Empty(t, parallelEnforceFlagOffenders(files), "a parallel top-level test sets the process-wide enforce flag, itself or through a helper (#16337, #16379)")
}

// The guard is proved with mutants: sources with the flag set in a helper (one level and two), called from a parallel test, which it must name; and the same helpers called from tests that are not
// parallel, or a parallel test that sets nothing, which it must leave alone.
func TestEnforceFlagGuardFollowsHelpers(t *testing.T) {
	src := "package routes\n\n" +
		"func enableEnforce(t *testing.T) {\n\tsetIdentityActorEnforced(true)\n\tt.Cleanup(func() { setIdentityActorEnforced(false) })\n}\n\n" +
		"func deeperHelper(t *testing.T) {\n\tenableEnforce(t)\n}\n\n" +
		"func (e *env) viaMethod(t *testing.T) {\n\tdeeperHelper(t)\n}\n\n" +
		"func TestDirectIsCaught(t *testing.T) {\n\tt.Parallel()\n\tsetIdentityActorEnforced(true)\n}\n\n" +
		"func TestOneLevelIsCaught(t *testing.T) {\n\tt.Parallel()\n\tenableEnforce(t)\n}\n\n" +
		"func TestTwoLevelsAreCaught(t *testing.T) {\n\tt.Parallel()\n\tdeeperHelper(t)\n}\n\n" +
		"func TestAMethodHelperIsCaught(t *testing.T) {\n\tt.Parallel()\n\te := &env{}\n\te.viaMethod(t)\n}\n\n" +
		"func TestSerialMayUseTheHelper(t *testing.T) {\n\tenableEnforce(t)\n}\n\n" +
		"func TestSerialParentWithParallelSubtests(t *testing.T) {\n\tenableEnforce(t)\n\tt.Run(\"a\", func(t *testing.T) {\n\t\tt.Parallel()\n\t})\n}\n\n" +
		"func TestParallelThatSetsNothing(t *testing.T) {\n\tt.Parallel()\n\tunrelated(t)\n}\n\n" +
		"func unrelated(t *testing.T) {}\n"
	got := parallelEnforceFlagOffenders(map[string]string{"mutant_test.go": src})
	assert.Equal(t, []string{
		"mutant_test.go: TestAMethodHelperIsCaught",
		"mutant_test.go: TestDirectIsCaught",
		"mutant_test.go: TestOneLevelIsCaught",
		"mutant_test.go: TestTwoLevelsAreCaught",
	}, got)
}
