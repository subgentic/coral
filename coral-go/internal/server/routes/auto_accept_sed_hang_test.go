package routes

import (
	"math/rand"
	"strings"
	"testing"
	"time"
)

// #7201 round 2 (QA's review): shellRisk must always return. sedScriptRuns looped forever on a sed script whose last character is a backslash (the address loop took the backslash for the start of
// another address and went round without moving), so one command text held an auto-accept check at 100% of a core with no end. The commands here are built at run time, so the equivalence test's scan of
// test sources does not pick them up.
func returnsWithin(command, workDir string, limit time.Duration) bool {
	done := make(chan struct{}, 1)
	go func() {
		shellRisk(command, workDir)
		done <- struct{}{}
	}()
	select {
	case <-done:
		return true
	case <-time.After(limit):
		return false
	}
}

func TestShellRiskSedScriptEndingInABackslashReturns(t *testing.T) {
	wd := t.TempDir()
	bs := string(rune(92))
	for _, script := range []string{bs, "p;" + bs, "1," + bs, "/x/d;" + bs, "s/a/b/;" + bs, "p" + bs} {
		command := strings.Join([]string{"sed", "-n", "'" + script + "'", "f"}, " ")
		if !returnsWithin(command, wd, 5*time.Second) {
			t.Errorf("shellRisk does not return for a sed script of %q", script)
			return // the stuck goroutine keeps a core busy until the test ends: one is enough
		}
	}
}

// Random sed scripts from the characters the scanner treats specially: every one must return. Stops at the first that does not.
func TestShellRiskSedScriptsAlwaysReturn(t *testing.T) {
	wd := t.TempDir()
	rnd := rand.New(rand.NewSource(7228))
	alphabet := []string{"s", "y", "e", "w", "W", "p", "d", "a", "i", "c", "b", "r", "q", "N", "1", "$", "/", "|", ",", ";", "{", "}", "!", "\n", " ", string(rune(92)), string(rune(92)), "I", "g", "x"}
	for i := 0; i < 4000; i++ {
		var script strings.Builder
		for k, n := 0, 1+rnd.Intn(12); k < n; k++ {
			script.WriteString(alphabet[rnd.Intn(len(alphabet))])
		}
		command := strings.Join([]string{"sed", "-e", "'" + strings.ReplaceAll(script.String(), "'", "") + "'", "f"}, " ")
		if !returnsWithin(command, wd, 3*time.Second) {
			t.Errorf("shellRisk does not return for a sed script of %q", script.String())
			return
		}
	}
}
