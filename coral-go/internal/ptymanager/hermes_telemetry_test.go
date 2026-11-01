package ptymanager

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11831: Hermes asks "Help improve Hermes?" on the first interactive start of a home (v0.22.5, #11715); nothing answers it in a launched agent, so Coral answers with the default, "No thanks", only when that
// is the choice the cursor is on.

const hermesTelemetryNoThanks = `
  Help improve Hermes?

  Asking once more: an earlier version could save "No thanks" before you saw this question.

  Shared metrics are bounded counters: activity, outcomes, error classes ...
  Details: https://hermes-agent.nousresearch.com/docs/developer-guide/relay-shared-metrics
  Change it any time: hermes setup telemetry

  ↑↓ navigate  ENTER/SPACE select  ESC cancel

    (○) Share with Nous
  → (●) No thanks
`

const hermesTelemetryShare = `
  Help improve Hermes?

  Shared metrics are bounded counters: activity, outcomes, error classes ...
  Change it any time: hermes setup telemetry

  ↑↓ navigate  ENTER/SPACE select  ESC cancel

  → (●) Share with Nous
    (○) No thanks
`

func TestHermesTelemetryIsRecognisedOnlyWithNoThanksSelected(t *testing.T) {
	assert.True(t, HermesTelemetryOnScreen(hermesTelemetryNoThanks))
	assert.False(t, HermesTelemetryOnScreen(hermesTelemetryShare), "Enter would share: never")
	assert.False(t, HermesTelemetryOnScreen(""))
	assert.False(t, HermesTelemetryOnScreen("> type here\n"))
	// the words in an agent's own text, with no question and no choices, are not the screen
	assert.False(t, HermesTelemetryOnScreen("the assistant said: No thanks, I will not help improve Hermes?\n→ (●) No thanks"), "the question is its own line")
	assert.False(t, HermesTelemetryOnScreen("Help improve Hermes?\n  (○) Share with Nous\n  (○) No thanks\n"), "nothing is selected")
	assert.False(t, HermesTelemetryOnScreen("Help improve Hermes?\n→ (●) No thanks and share\n"), "the selected choice is exactly No thanks")
}

// hermesScreenTerm is a terminal whose screen is read from a script (the last one repeats) and whose Enters are counted.
type hermesScreenTerm struct {
	mu      sync.Mutex
	screens []string
	reads   int
	enters  int
}

func (s *hermesScreenTerm) AgentScreen(context.Context, string, string, string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.reads
	if i >= len(s.screens) {
		i = len(s.screens) - 1
	}
	s.reads++
	return s.screens[i], nil
}

func (s *hermesScreenTerm) SendEnter(context.Context, string, string, string) error {
	s.mu.Lock()
	s.enters++
	s.mu.Unlock()
	return nil
}

func TestAnswerHermesTelemetryPressesEnterOnceAndStopsWhenItIsGone(t *testing.T) {
	term := &hermesScreenTerm{screens: []string{"loading...\n", "loading...\n", hermesTelemetryNoThanks, hermesTelemetryNoThanks, "> \n"}}
	answered := AnswerHermesTelemetry(context.Background(), term, "hermes-x", "hermes", "sid", time.Second, time.Millisecond)
	assert.True(t, answered)
	assert.Equal(t, 1, term.enters, "one Enter for one question, though two reads still showed it")
}

func TestAnswerHermesTelemetryNeverAnswersShareAndGivesUpAfterTheWait(t *testing.T) {
	term := &hermesScreenTerm{screens: []string{hermesTelemetryShare}}
	assert.False(t, AnswerHermesTelemetry(context.Background(), term, "hermes-x", "hermes", "sid", 30*time.Millisecond, time.Millisecond))
	assert.Zero(t, term.enters)
	term = &hermesScreenTerm{screens: []string{"> \n"}}
	start := time.Now()
	assert.False(t, AnswerHermesTelemetry(context.Background(), term, "hermes-x", "hermes", "sid", 30*time.Millisecond, time.Millisecond))
	assert.Zero(t, term.enters)
	assert.Less(t, time.Since(start), time.Second)
}

func TestAnswerHermesTelemetryStopsOnACancelledContextAndASilentTerminal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	term := &hermesScreenTerm{screens: []string{hermesTelemetryNoThanks}}
	assert.False(t, AnswerHermesTelemetry(ctx, term, "n", "hermes", "s", time.Second, time.Millisecond))
	assert.Zero(t, term.enters)
	// a terminal that cannot be read or cannot press Enter does nothing, and does not hang
	assert.False(t, AnswerHermesTelemetry(context.Background(), struct{}{}, "n", "hermes", "s", 20*time.Millisecond, time.Millisecond))
	require.True(t, true)
}
