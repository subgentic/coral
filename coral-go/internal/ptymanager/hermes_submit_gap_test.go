package ptymanager

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/terminalinput"
)

// #11831: Hermes's TUI takes text and an Enter that arrive together as a paste: the Enter must come a full second after the text (checked on v0.22.5, #11715), where the other agents need 150-400 ms.

// gapBetweenWrites runs send against a fake session of agentType and returns the time between its first write (the text) and the last (the Enter).
func gapBetweenWrites(t *testing.T, agentType string, send func(b *PTYBackend, name string) error) time.Duration {
	t.Helper()
	withFastSubmit(t)
	name := agentType + "-gap"
	b, s, proc := newFakeBackend(t, name)
	s.agentType = agentType
	s.bracketedPaste.Store(true)
	var mu sync.Mutex
	var stamps []time.Time
	proc.writeFn = func(call int, p []byte) (int, error) {
		mu.Lock()
		stamps = append(stamps, time.Now())
		mu.Unlock()
		return len(p), nil
	}
	if err := send(b, name); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(stamps) < 2 {
		t.Fatalf("want text and Enter, got %d writes", len(stamps))
	}
	return stamps[len(stamps)-1].Sub(stamps[0])
}

func TestHermesGetsItsEnterASecondAfterThePastedText(t *testing.T) {
	paste := func(b *PTYBackend, name string) error {
		return b.SendPrompt(context.Background(), terminalinput.Unclassified, name, "hello\nthere")
	}
	if gap := gapBetweenWrites(t, "hermes", paste); gap < time.Second {
		t.Fatalf("hermes: Enter after %v, want at least 1s", gap)
	}
	if gap := gapBetweenWrites(t, "claude", paste); gap >= 500*time.Millisecond {
		t.Fatalf("claude: Enter after %v, the other agents are not slowed", gap)
	}
}

func TestHermesGetsItsEnterASecondAfterTypedText(t *testing.T) {
	line := func(b *PTYBackend, name string) error {
		return b.SendLine(terminalinput.Unclassified, name, "one line")
	}
	if gap := gapBetweenWrites(t, "hermes", line); gap < time.Second {
		t.Fatalf("hermes: Enter after %v, want at least 1s", gap)
	}
	if gap := gapBetweenWrites(t, "claude", line); gap >= 800*time.Millisecond {
		t.Fatalf("claude: Enter after %v", gap)
	}
}
