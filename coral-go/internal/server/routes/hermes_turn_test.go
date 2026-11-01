package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11831: Hermes's hooks open a turn (pre_llm_call) and close it (on_session_end), but a Ctrl-C and a provider that gave up fire no closing hook (#11715): the dot would stay Working for ever. Two fallbacks close
// it: the pane saying the operation was interrupted, and a turn that has been silent for ten minutes.

func evAt(kind string, ago time.Duration, now time.Time) store.AgentEvent {
	return store.AgentEvent{EventType: kind, CreatedAt: now.Add(-ago).UTC().Format(time.RFC3339Nano)}
}

func TestHermesInterruptIsRecognisedOnTheScreensLastLines(t *testing.T) {
	assert.True(t, hermesInterruptedOnScreen("some output\n\n  Operation interrupted\n\n> \n"))
	assert.True(t, hermesInterruptedOnScreen("x\n⚠ Operation interrupted by user\n"))
	assert.False(t, hermesInterruptedOnScreen(""))
	assert.False(t, hermesInterruptedOnScreen("working...\n"))
	// older than the last lines: a new turn has drawn below it
	old := "Operation interrupted\n" + strings.Repeat("new output line\n", 6)
	assert.False(t, hermesInterruptedOnScreen(old))
	// the words in a long line of ordinary text are not the notice
	assert.False(t, hermesInterruptedOnScreen("the agent wrote: Operation interrupted can happen when you press ctrl-c in a long turn and more words follow here\n"))
}

func TestHermesAnOpenTurnIsClosedByAnInterruptedScreenOrTenSilentMinutes(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	open := func(kind string, ago time.Duration) []store.AgentEvent { return []store.AgentEvent{evAt(kind, ago, now)} }

	// an interrupted screen, the last event at least 3 s old: the turn is over
	kind, at := hermesTurnFallback(open("prompt_submit", 30*time.Second), "x\nOperation interrupted\n", now)
	assert.Equal(t, "stop", kind)
	assert.Equal(t, now, at)
	kind, _ = hermesTurnFallback(open("tool_use", 30*time.Second), "Operation interrupted\n", now)
	assert.Equal(t, "stop", kind)
	// the same screen a second after a new prompt: the notice is the old turn's
	kind, _ = hermesTurnFallback(open("prompt_submit", time.Second), "Operation interrupted\n", now)
	assert.Equal(t, "", kind)
	// a request for the person is a wait, not a turn to close
	kind, _ = hermesTurnFallback(open("permission_request", time.Hour), "Operation interrupted\n", now)
	assert.Equal(t, "", kind)
	// a turn already closed
	kind, _ = hermesTurnFallback(open("stop", time.Hour), "Operation interrupted\n", now)
	assert.Equal(t, "", kind)
	kind, _ = hermesTurnFallback(nil, "Operation interrupted\n", now)
	assert.Equal(t, "", kind)

	// silence: nine minutes is a slow turn, eleven is over, with any screen
	kind, _ = hermesTurnFallback(open("tool_use", 9*time.Minute), "working\n", now)
	assert.Equal(t, "", kind)
	kind, at = hermesTurnFallback(open("tool_use", 11*time.Minute), "working\n", now)
	assert.Equal(t, "stop", kind)
	assert.Equal(t, now, at)
	// a screen that could not be read still lets the silence close the turn
	kind, _ = hermesTurnFallback(open("prompt_submit", 11*time.Minute), "", now)
	assert.Equal(t, "stop", kind)
	require.True(t, true)
}
