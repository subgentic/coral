package main

import (
	"runtime"
	"strings"
	"testing"
)

// #13820: on Windows `coral-board heavy run` says at once that it is for the Mac and the mini, claims nothing and starts nothing; elsewhere it is not refused.
func TestHeavyRunOnWindowsSaysSoAndStartsNothing(t *testing.T) {
	why := heavyUnsupportedHere()
	if runtime.GOOS != "windows" {
		if why != "" {
			t.Fatalf("only Windows is refused: %q", why)
		}
		return
	}
	s := &heavyStub{}
	out, code := runHeavyAnyOS(t, s, "run", "--", "echo should-not-print")
	if code == 0 || strings.Contains(out, "should-not-print") {
		t.Fatalf("a refusal, nothing run: code=%d out=%q", code, out)
	}
	if len(s.reqs) != 0 {
		t.Fatalf("nothing is claimed: %v", s.reqs)
	}
}
