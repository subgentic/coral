package agenttypes

import (
	"testing"
	"time"
)

func TestOnlyHermesNeedsASecondBetweenTextAndEnter(t *testing.T) {
	if got := MinSubmitGap(Hermes); got != time.Second {
		t.Fatalf("hermes: %v", got)
	}
	for _, typ := range []string{Claude, Agy, Antigravity, Gemini, Codex, Pi, Terminal, "", "Hermes", "hermes "} {
		if got := MinSubmitGap(typ); got != 0 {
			t.Fatalf("%q: %v, the others keep their own delays", typ, got)
		}
	}
}
