package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #12169 (e), the Hermes tester: a healthy standalone Hermes agent with no first message showed "Check terminal" and "may be waiting at a startup prompt". Every other CLI sends a hook event at launch, so none for
// 25 seconds means its terminal needs a look; Hermes sends no hook event until its first turn (about 80 s on a home used for the first time), so the same silence is a Hermes agent that is ready and waiting for
// its first message. The time rules leave it out; a prompt it really draws at launch is still caught from its screen (startupPromptState), and an agent that has had its turn is judged by its events.
func TestHermesSilenceBeforeItsFirstTurnIsNotAnAgentThatDidNotStart(t *testing.T) {
	const old, window = 60.0, 30.0 // seconds: silent for longer than the threshold, inside the window
	assert.True(t, agentNeverStarted("claude", "", old, window), "the rule still holds for the others")
	assert.True(t, agentNeverStarted("pi", "", old, window))
	assert.False(t, agentNeverStarted("hermes", "", old, window), "Hermes: silence before its first turn is healthy")
	assert.True(t, agentStarting("claude", "", window, false, false, false), "the others are Starting until their first event")
	assert.False(t, agentStarting("hermes", "", window, false, false, false), "Hermes is not Starting for as long as it waits for a first message")
}
