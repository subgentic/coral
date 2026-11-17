package ptymanager

import (
	"testing"
	"time"
)

// A start spaced past MaxStartWait (the Codex first-start gap) keeps its mark for its whole delay (#18991).
func TestMarkStartPending_StandsForTheStartsOwnDelay(t *testing.T) {
	done := MarkStartPending("s-18991-long.0", 3*time.Minute)
	defer done()
	pendingStarts.Lock()
	until := pendingStarts.until["s-18991-long"]
	pendingStarts.Unlock()
	if want := time.Now().Add(3 * time.Minute); until.Before(want) {
		t.Fatalf("mark stands until %v, before the start's own %v", until, want)
	}
	if !StartPending("S-18991-LONG") {
		t.Fatal("not pending")
	}
}

func TestMarkStartPending_DoneNotesWhenItWasTyped(t *testing.T) {
	done := MarkStartPending("s-18991-typed", 0)
	if _, ok := StartTypedAt("s-18991-typed"); ok {
		t.Fatal("typed before it was")
	}
	done()
	at, ok := StartTypedAt("s-18991-typed.0")
	if !ok || time.Since(at) > time.Second {
		t.Fatalf("typed time = %v, %v", at, ok)
	}
	if StartPending("s-18991-typed") {
		t.Fatal("still pending")
	}
}
